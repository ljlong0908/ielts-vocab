#!/usr/bin/env python3
"""
wxcloud.py —— 微信云开发 HTTP API 的本地客户端（公共层）

为什么需要这层：云开发控制台能做的事，HTTP API 几乎都能做，而且**能脚本化**——
一次写好、幂等、可重复执行，不必在控制台里一个个人肉点。本项目把整个
「初始化」都搬到了本地：

  取凭证   GET  /cgi-bin/token
  查集合   POST /tcb/databasecollectionget
  建集合   POST /tcb/databasecollectionadd
  建索引   POST /tcb/updateindex
  读数据   POST /tcb/databasequery
  写数据   POST /tcb/databaseadd / databaseupdate / databasedelete
  传文件   POST /tcb/uploadfile     （拿到 COS 直传地址后再 POST 一次二进制）
  删文件   POST /tcb/batchdeletefile

被谁用：
  scripts/init_cloud.py   建集合 + 建索引
  scripts/seed_cloud.py   导词表 + 传音频 + 写 audio_cache + 点亮 audioReady

⚠️ 唯一没有 HTTP API、仍必须去控制台的一步：集合的**安全规则（权限）**。
⚠️ AppSecret 是小程序的最高权限凭证，只放本地 .env，切勿入库、切勿配进云函数。
"""
from __future__ import annotations

import json
import os
import re
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://api.weixin.qq.com"
TOKEN_CACHE = os.path.join(ROOT, "build", ".wx-token.json")

# 常见错误码 → 人话
ERR_HINT = {
    40001: "AppSecret 不对（或已被重置）",
    40013: "AppID 不对",
    40125: "AppSecret 无效",
    40164: "本机公网 IP 不在小程序后台的 IP 白名单里 → 「开发管理 → 开发设置 → IP 白名单」加上它",
    85088: "该 AppID 未开通云开发",
    47001: "POST BODY 格式错误",
    43002: "HTTP METHOD 错误",
    41001: "缺少 access_token",
    42001: "access_token 过期（脚本会自动重取）",
    502003: "无权限操作数据库（检查环境 ID 是否属于该 AppID）",
    502005: "集合不存在",
}


class CloudError(RuntimeError):
    """云开发接口返回了非 0 的 errcode，或传输层出错。"""


# ---------------------------------------------------------------- 小工具

def log(msg=""):
    print(msg, flush=True)


def step(title):
    log()
    log(f"=== {title} ===")


def explain(payload):
    """把 errcode 翻成人话。"""
    code = payload.get("errcode")
    hint = ERR_HINT.get(code)
    return f"errcode={code} errmsg={payload.get('errmsg')}" + (f"  → {hint}" if hint else "")


# ---------------------------------------------------------------- 配置发现

def load_env(path=None):
    """把项目根 .env 读进环境变量（已存在的环境变量优先，绝不覆盖）。"""
    path = path or os.path.join(ROOT, ".env")
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def find_appid():
    p = os.path.join(ROOT, "project.config.json")
    if os.path.isfile(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f).get("appid", "")
        except Exception:  # noqa: BLE001
            pass
    return ""


def find_env_id():
    """从 miniprogram/config.js 里抠 ENV_ID。"""
    p = os.path.join(ROOT, "miniprogram", "config.js")
    if os.path.isfile(p):
        with open(p, encoding="utf-8") as f:
            m = re.search(r"ENV_ID\s*:\s*['\"]([^'\"]+)['\"]", f.read())
            if m:
                return m.group(1)
    return ""


def require_config():
    """按「命令行 > 环境变量 > 项目文件」的优先级凑齐三件套。"""
    load_env()
    appid = os.environ.get("WX_APPID", "").strip() or find_appid()
    secret = os.environ.get("WX_APP_SECRET", "").strip()
    env = os.environ.get("ENV_ID", "").strip() or find_env_id()
    return appid, secret, env


# ---------------------------------------------------------------- access_token

def get_token(appid, secret, refresh=False, session=None):
    """取 access_token，返回 (token, 说明)。

    优先用缓存：微信对获取频率有限制，反复取会把上一次的顶掉。
    """
    s = session or requests
    if not refresh and os.path.isfile(TOKEN_CACHE):
        try:
            with open(TOKEN_CACHE, encoding="utf-8") as f:
                c = json.load(f)
            if c.get("appid") == appid and c.get("expire_at", 0) > time.time() + 60:
                return c["access_token"], f"用缓存（{int(c['expire_at'] - time.time())}s 后过期）"
        except Exception:  # noqa: BLE001
            pass

    r = s.get(f"{API}/cgi-bin/token", params={
        "grant_type": "client_credential", "appid": appid, "secret": secret,
    }, timeout=30)
    payload = r.json()
    if payload.get("errcode"):
        raise CloudError(f"取 access_token 失败：{explain(payload)}")

    token = payload["access_token"]
    exp = int(payload.get("expires_in", 7200))
    os.makedirs(os.path.dirname(TOKEN_CACHE), exist_ok=True)
    with open(TOKEN_CACHE, "w", encoding="utf-8") as f:
        json.dump({"appid": appid, "access_token": token, "expire_at": time.time() + exp}, f)
    return token, f"新获取（有效期 {exp}s）"


# ---------------------------------------------------------------- 云环境句柄

class Cloud:
    """一个云环境的读写句柄：数据库 + 云存储。"""

    def __init__(self, token, env, session=None):
        self.token = token
        self.env = env
        self.s = session or requests.Session()

    # ---------- 传输层

    def call(self, path, body=None, *, raw=False):
        """POST /tcb/<path>；errcode 非 0 时抛 CloudError（raw=True 则原样返回）。"""
        url = f"{API}/tcb/{path}?access_token={self.token}"
        try:
            r = self.s.post(url, json=body or {}, timeout=60)
        except Exception as e:  # noqa: BLE001
            raise CloudError(f"{path} 请求失败：{type(e).__name__}: {e}") from e
        try:
            payload = r.json()
        except Exception:  # noqa: BLE001
            raise CloudError(f"{path} 返回不是 JSON：HTTP {r.status_code} {r.text[:200]}")
        if raw:
            return payload
        if payload.get("errcode"):
            raise CloudError(f"{path} 失败：{explain(payload)}")
        return payload

    # ---------- 集合

    def collections(self):
        """返回 {name: {count, index_count}}，自动翻页。"""
        out, offset = {}, 0
        while True:
            p = self.call("databasecollectionget", {"env": self.env, "limit": 100, "offset": offset})
            items = p.get("collections") or []
            for it in items:
                out[it["name"]] = {"count": it.get("count", 0), "index_count": it.get("index_count", 0)}
            offset += len(items)
            total = (p.get("pager") or {}).get("Total") or 0
            if not items or offset >= total:
                break
        return out

    def create_collection(self, name):
        try:
            self.call("databasecollectionadd", {"env": self.env, "collection_name": name})
            return None
        except CloudError as e:
            if "exist" in str(e).lower():
                return "ALREADY_EXISTS"
            raise

    def create_index(self, collection_name, name, keys, unique=False):
        """建一条索引；已存在视为通过（幂等）。"""
        body = {
            "env": self.env,
            "collection_name": collection_name,
            "create_indexes": [{"name": name, "unique": bool(unique), "keys": keys}],
            "drop_indexes": [],
        }
        try:
            self.call("updateindex", body)
            return None
        except CloudError as e:
            msg = str(e).lower()
            if "exist" in msg or "duplicate" in msg:
                return "ALREADY_EXISTS"
            raise

    # ---------- 数据

    def query(self, q):
        """执行一段查询语句，返回文档列表（data 里的 JSON 串已解析）。"""
        p = self.call("databasequery", {"env": self.env, "query": q})
        return [json.loads(s) for s in (p.get("data") or [])]

    def query_total(self, q):
        p = self.call("databasequery", {"env": self.env, "query": q})
        return (p.get("pager") or {}).get("Total", 0)

    def count(self, collection):
        return self.query_total(f'db.collection("{collection}").count()')

    def add(self, q):
        return self.call("databaseadd", {"env": self.env, "query": q})

    def update(self, q):
        return self.call("databaseupdate", {"env": self.env, "query": q})

    def remove(self, q):
        return self.call("databasedelete", {"env": self.env, "query": q})

    def purge(self, collection, batch=500):
        """清空一个集合，返回实际删除条数（幂等：空集合返回 0）。

        用 where({_id: exists}) 分页删，避免单次过大；删不动即停，防死循环。
        """
        removed = 0
        for _ in range(10000):
            ids = [d["_id"] for d in self.query(
                f'db.collection("{collection}").where({{_id: db.command.exists(true)}})'
                f'.field({{_id:true}}).limit({batch}).get()')]
            if not ids:
                break
            arr = ",".join(json.dumps(i) for i in ids)
            r = self.remove(f'db.collection("{collection}").where({{_id: db.command.in([{arr}])}}).remove()')
            n = r.get("deleted", 0)
            removed += n
            if n == 0:
                break
            if len(ids) < batch:
                break
        return removed

    # ---------- 云存储

    def upload(self, cloud_path, data, content_type="audio/mpeg", timeout=120):
        """直传云存储，返回 fileID（cloud://...）。

        流程：先向 tcb/uploadfile 申请凭证（含 COS 直传地址与签名），
        再用 POST multipart 把二进制打到该地址。字段必须带 key，
        签名放 Authorization 头 —— 这两点缺一都会 400 MalformedPOSTRequest
        或 403 SignatureDoesNotMatch。
        """
        cred = self.call("uploadfile", {"env": self.env, "path": cloud_path})
        url = cred.get("url")
        if not url:
            raise CloudError(f"uploadfile 未返回 url：{cred}")
        headers = {
            "Authorization": cred.get("authorization", ""),
            "x-cos-security-token": cred.get("token", ""),
        }
        r = self.s.post(
            url,
            files={"file": (os.path.basename(cloud_path), data, content_type)},
            data={"key": cloud_path},
            headers=headers,
            timeout=timeout,
        )
        if r.status_code not in (200, 204):
            raise CloudError(f"上传 {cloud_path} 失败：HTTP {r.status_code} {r.text[:200]}")
        return cred.get("file_id", "")

    def remove_files(self, file_ids):
        """批量删云存储文件，返回 {fileid: status}。文件不存在不算错。"""
        if not file_ids:
            return {}
        out = {}
        for i in range(0, len(file_ids), 50):
            chunk = file_ids[i:i + 50]
            p = self.call("batchdeletefile", {"env": self.env, "fileid_list": chunk})
            for it in p.get("delete_list") or []:
                out[it.get("fileid")] = it.get("status")
        return out
