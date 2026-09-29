#!/usr/bin/env python3
"""
init_cloud.py —— 在**本地**初始化云数据库：建集合 + 建索引（走微信云开发 HTTP API）

为什么需要：云开发控制台建集合、建索引都要一个个手点（7 集合 + 10 索引），
容易漏一两个、然后运行时才炸。微信云开发的 HTTP API 提供了对应接口，
可以在本地一条命令做完，而且**建索引也能做**（控制台之外的唯一途径）：

  取凭证  GET  https://api.weixin.qq.com/cgi-bin/token
  查现状  POST https://api.weixin.qq.com/tcb/databasecollectionget   （含 index_count）
  建集合  POST https://api.weixin.qq.com/tcb/databasecollectionadd
  建索引  POST https://api.weixin.qq.com/tcb/updateindex

⚠️ 唯一仍需控制台手工的一步：集合的**安全规则（权限）**——HTTP API 没有对应接口。
   建议 words = 所有用户可读 / 仅管理端可写；其余 = 仅创建者可读写。

用法：
  python scripts/init_cloud.py                 # 体检（默认，不改云端任何东西）
  python scripts/init_cloud.py --apply         # 执行：建缺失集合 + 补缺失索引（幂等）
  python scripts/init_cloud.py --apply --skip-indexes      # 只建集合
  python scripts/init_cloud.py --apply --skip-collections  # 只建索引
  python scripts/init_cloud.py --env cloud1-xxxxxxxx       # 临时指定环境
  python scripts/init_cloud.py --refresh-token             # 强制换新 access_token

前置：项目根 .env 里要有两行（.env 已 gitignore）
  WX_APP_SECRET=<小程序后台「开发管理 → 开发设置」里的 AppSecret>
  ENV_ID=<云环境 ID>            # 不写则自动从 miniprogram/config.js 读
AppID 自动从 project.config.json 读。

⚠️ AppSecret 是**小程序最高权限凭证**，只放本地 .env：
   不要写进小程序代码，也不要配到云函数环境变量里。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "assets", "db-indexes.json")
INIT_DB_JS = os.path.join(ROOT, "cloudfunctions", "init_db", "index.js")
TOKEN_CACHE = os.path.join(ROOT, "build", ".wx-token.json")

API = "https://api.weixin.qq.com"

# 常见错误码 → 人话
ERR_HINT = {
    40001: "AppSecret 不对（或已被重置）",
    40013: "AppID 不对",
    40125: "AppSecret 无效",
    40164: "当前公网 IP 不在小程序后台的 IP 白名单里 → 去小程序后台「开发管理 → 开发设置 → IP 白名单」加上本机出口 IP",
    85088: "该 AppID 未开通云开发",
    47001: "POST BODY 格式错误",
    43002: "HTTP METHOD 错误",
    41001: "缺少 access_token",
    42001: "access_token 过期（脚本会自动重取）",
    502003: "无权限操作数据库（检查环境 ID 是否属于该 AppID）",
    502005: "集合不存在",
}


# ---------------------------------------------------------------- 基础工具

def log(msg=""):
    print(msg, flush=True)


def step(n, total, title):
    log()
    log(f"=== {n}/{total} {title} ===")


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


def http_json(url, body=None, method=None, timeout=30):
    """发一个 JSON 请求，返回 (dict, None) 或 (None, 错误说明)。"""
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}"
    except Exception as e:  # noqa: BLE001
        return None, f"{type(e).__name__}: {str(e)[:200]}"
    try:
        return json.loads(raw), None
    except Exception:  # noqa: BLE001
        return None, f"返回不是 JSON：{raw[:200]}"


def explain(payload):
    """把 errcode 翻成人话。"""
    code = payload.get("errcode")
    hint = ERR_HINT.get(code)
    return f"errcode={code} errmsg={payload.get('errmsg')}" + (f"  → {hint}" if hint else "")


# ---------------------------------------------------------------- 配置发现

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


def load_manifest():
    if not os.path.isfile(MANIFEST):
        sys.exit(f"找不到清单 {MANIFEST}")
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- access_token

def get_token(appid, secret, refresh=False):
    """取 access_token；优先用缓存（微信有频率限制，反复取会互相顶掉）。"""
    if not refresh and os.path.isfile(TOKEN_CACHE):
        try:
            with open(TOKEN_CACHE, encoding="utf-8") as f:
                c = json.load(f)
            if c.get("appid") == appid and c.get("expire_at", 0) > time.time() + 60:
                return c["access_token"], f"用缓存（{int(c['expire_at'] - time.time())}s 后过期）"
        except Exception:  # noqa: BLE001
            pass

    q = urllib.parse.urlencode({
        "grant_type": "client_credential", "appid": appid, "secret": secret,
    })
    payload, err = http_json(f"{API}/cgi-bin/token?{q}")
    if err:
        sys.exit(f"取 access_token 失败：{err}")
    if payload.get("errcode"):
        sys.exit(f"取 access_token 失败：{explain(payload)}")

    token = payload["access_token"]
    exp = int(payload.get("expires_in", 7200))
    os.makedirs(os.path.dirname(TOKEN_CACHE), exist_ok=True)
    with open(TOKEN_CACHE, "w", encoding="utf-8") as f:
        json.dump({"appid": appid, "access_token": token, "expire_at": time.time() + exp}, f)
    return token, f"新获取（有效期 {exp}s）"


# ---------------------------------------------------------------- 云开发接口

def tcbcall(token, path, body):
    payload, err = http_json(f"{API}/tcb/{path}?access_token={token}", body=body)
    if err:
        return None, err
    return payload, None


def list_collections(token, env):
    """返回 {name: {count, index_count}}；分页拉全。"""
    out, offset = {}, 0
    while True:
        payload, err = tcbcall(token, "databasecollectionget",
                               {"env": env, "limit": 100, "offset": offset})
        if err:
            return None, err
        if payload.get("errcode"):
            return None, explain(payload)
        items = payload.get("collections") or []
        for it in items:
            out[it["name"]] = {"count": it.get("count", 0), "index_count": it.get("index_count", 0)}
        pager = payload.get("pager") or {}
        offset += len(items)
        if not items or offset >= (pager.get("Total") or 0):
            break
    return out, None


def create_collection(token, env, name):
    payload, err = tcbcall(token, "databasecollectionadd", {"env": env, "collection_name": name})
    if err:
        return f"请求失败：{err}"
    if payload.get("errcode") == 0:
        return None
    if payload.get("errcode") == -502013 or "exist" in str(payload.get("errmsg", "")).lower():
        return "ALREADY_EXISTS"
    return explain(payload)


def create_index(token, env, spec):
    payload, err = tcbcall(token, "updateindex", {
        "env": env,
        "collection_name": spec["collection"],
        "create_indexes": [{
            "name": spec["name"],
            "unique": bool(spec["unique"]),
            "keys": spec["keys"],
        }],
        "drop_indexes": [],
    })
    if err:
        return f"请求失败：{err}"
    if payload.get("errcode") == 0:
        return None
    msg = str(payload.get("errmsg", "")).lower()
    if "exist" in msg or "duplicate" in msg:
        return "ALREADY_EXISTS"
    return explain(payload)


# ---------------------------------------------------------------- 一致性告警

def check_manifest_sync(manifest):
    """清单与 init_db/index.js 的粗粒度比对：集合出现次数是否一致。

    不做精细解析（索引字段名在 JS 里是 `a + b` 的展示串），只抓「一边加了、
    另一边没加」这种最常见的漂移。
    """
    if not os.path.isfile(INIT_DB_JS):
        return None
    with open(INIT_DB_JS, encoding="utf-8") as f:
        src = f.read()
    # 只看 INDEXES 数组区段，避免把 EXPECTED 里的 collection 字段算进来
    m = re.search(r"const INDEXES\s*=\s*\[(.*?)\n\]", src, re.S)
    seg = m.group(1) if m else ""
    js_counts = {}
    for name in re.findall(r"collection:\s*'([^']+)'", seg):
        js_counts[name] = js_counts.get(name, 0) + 1
    py_counts = {}
    for it in manifest["indexes"]:
        py_counts[it["collection"]] = py_counts.get(it["collection"], 0) + 1
    return None if js_counts == py_counts else (js_counts, py_counts)


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description="本地初始化云数据库（建集合 + 建索引）")
    ap.add_argument("--apply", action="store_true", help="真正执行（默认只体检，不改云端）")
    ap.add_argument("--env", default="", help="云环境 ID（默认从 miniprogram/config.js 读）")
    ap.add_argument("--appid", default="", help="小程序 AppID（默认从 project.config.json 读）")
    ap.add_argument("--secret", default="", help="AppSecret（默认读 .env 的 WX_APP_SECRET）")
    ap.add_argument("--skip-collections", action="store_true", help="跳过建集合")
    ap.add_argument("--skip-indexes", action="store_true", help="跳过建索引")
    ap.add_argument("--refresh-token", action="store_true", help="强制重新获取 access_token")
    args = ap.parse_args()

    load_env()
    manifest = load_manifest()
    collections = manifest["collections"]
    indexes = manifest["indexes"]

    appid = args.appid or os.environ.get("WX_APPID", "").strip() or find_appid()
    secret = args.secret or os.environ.get("WX_APP_SECRET", "").strip()
    env = args.env or os.environ.get("ENV_ID", "").strip() or find_env_id()

    log(f"项目根      {ROOT}")
    log(f"AppID       {appid or '（未找到）'}")
    log(f"云环境 ID   {env or '（未找到）'}")
    log(f"清单        {len(collections)} 个集合 / {len(indexes)} 条索引")
    log(f"模式        {'★ 执行（--apply）' if args.apply else '体检（只读，不改云端）'}")

    drift = check_manifest_sync(manifest)
    if drift:
        js, py = drift
        log()
        log("⚠️ 清单与 init_db/index.js 的索引数不一致（可能有一边改漏了）：")
        log(f"     init_db/index.js : {js}")
        log(f"     assets/db-indexes.json : {py}")

    if not appid:
        sys.exit("\n缺少 AppID：请填 project.config.json 的 appid，或用 --appid 指定")
    if not env:
        sys.exit("\n缺少云环境 ID：请改 miniprogram/config.js 的 ENV_ID，或用 --env 指定")
    if not secret:
        sys.exit(
            "\n缺少 AppSecret：请在项目根 .env 里加一行\n"
            "    WX_APP_SECRET=<小程序后台「开发管理 → 开发设置」里的 AppSecret>\n"
            "（AppSecret 是小程序最高权限凭证，只放本地 .env，勿入库、勿配到云函数）"
        )

    TOTAL = 3
    step(1, TOTAL, "获取 access_token")
    token, how = get_token(appid, secret, refresh=args.refresh_token)
    log(f"  ✓ {how}")

    step(2, TOTAL, "集合体检")
    existing, err = list_collections(token, env)
    if err:
        sys.exit(f"  读取集合失败：{err}")
    missing = [c["name"] for c in collections if c["name"] not in existing]
    for c in collections:
        cur = existing.get(c["name"])
        if cur:
            log(f"  ✓ {c['name']:<14} 已存在   文档 {cur['count']:<8} 索引 {cur['index_count']}")
        else:
            log(f"  ✗ {c['name']:<14} 缺失     {c['desc']}")
    log(f"  → {len(collections) - len(missing)}/{len(collections)} 就绪"
        + (f"，缺 {len(missing)} 个：{' / '.join(missing)}" if missing else ""))

    if args.apply and missing and not args.skip_collections:
        log()
        log("  建集合：")
        for name in missing:
            r = create_collection(token, env, name)
            if r is None:
                log(f"    ✓ {name}")
            elif r == "ALREADY_EXISTS":
                log(f"    - {name}  已存在（竞态，忽略）")
            else:
                log(f"    ✗ {name}  {r}")
        existing, err = list_collections(token, env)
        if err:
            sys.exit(f"  复查失败：{err}")
        still = [n for n in missing if n not in existing]
        log(f"  → 复查：{'全部就绪' if not still else '仍缺 ' + ' / '.join(still)}")

    step(3, TOTAL, "索引体检")
    # 每个集合的「自定义索引」数 = index_count − 1（减去内置的 _id_）
    plan = {}
    for it in indexes:
        plan.setdefault(it["collection"], []).append(it)

    to_create = []
    for coll, specs in plan.items():
        cur = existing.get(coll)
        if not cur:
            log(f"  - {coll:<14} 集合不存在，跳过（先建集合）")
            for s in specs:
                log(f"      ? {s['name']:<42} 待集合就绪后创建")
            continue
        have = max(0, cur["index_count"] - 1)
        log(f"  {coll:<14} 自定义索引 {have}/{len(specs)}")
        for s in specs:
            log(f"      · {s['name']:<42} {s['note']}")
        to_create.extend(specs)

    if args.apply and to_create and not args.skip_indexes:
        log()
        log("  建索引（幂等：已存在的会报 exists，视为通过）：")
        for s in to_create:
            r = create_index(token, env, s)
            tag = f"{s['collection']}.{s['name']}"
            if r is None:
                log(f"    ✓ {tag}")
            elif r == "ALREADY_EXISTS":
                log(f"    - {tag}  已存在（跳过）")
            else:
                log(f"    ✗ {tag}  {r}")
        existing2, err = list_collections(token, env)
        if not err:
            log()
            log("  复查（自定义索引数 / 期望）：")
            for coll, specs in plan.items():
                cur = existing2.get(coll)
                if not cur:
                    continue
                have = max(0, cur["index_count"] - 1)
                mark = "✓" if have >= len(specs) else "✗"
                log(f"    {mark} {coll:<14} {have}/{len(specs)}")

    log()
    if not args.apply:
        log("—— 以上为体检结果，云端未被改动。加 --apply 执行。")
    else:
        log("—— 执行完成。")
    log()
    log("⚠️ 还剩一步只能手工：集合的**安全规则**")
    log("   云开发控制台 → 数据库 → 选集合 → 权限设置")
    log("     words      → 所有用户可读，仅管理端可写")
    log("     其余 6 个  → 仅创建者可读写")
    log("   另外确认：设置里「未登录用户访问云资源」= 关闭；云函数不使用 HTTP 触发路径。")


if __name__ == "__main__":
    main()
