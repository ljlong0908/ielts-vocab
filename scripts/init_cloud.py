#!/usr/bin/env python3
"""
init_cloud.py —— 在**本地**初始化云数据库：建集合 + 建索引（走微信云开发 HTTP API）

为什么需要：云开发控制台建集合、建索引都要一个个手点（7 集合 + 10 索引），
容易漏一两个、然后运行时才炸。走 HTTP API 就能在本地一条命令做完，而且
**建索引也能做**（这是控制台之外的唯一途径）。

  取凭证  GET  /cgi-bin/token
  查集合  POST /tcb/databasecollectionget   （含 index_count）
  建集合  POST /tcb/databasecollectionadd
  建索引  POST /tcb/updateindex

⚠️ 唯一仍需控制台手工的一步：集合的**安全规则（权限）**——HTTP API 没有对应接口。
   建议 words = 所有用户可读 / 仅管理端可写；其余 = 仅创建者可读写。
⚠️ 数据（词表 / 音频 / audio_cache）不在这里导，见 scripts/seed_cloud.py。

用法：
  python scripts/init_cloud.py                 # 体检（默认，不改云端任何东西）
  python scripts/init_cloud.py --apply         # 执行：建缺失集合 + 补缺失索引（幂等）
  python scripts/init_cloud.py --apply --skip-indexes      # 只建集合
  python scripts/init_cloud.py --apply --skip-collections  # 只建索引
  python scripts/init_cloud.py --env cloud1-xxxxxxxx       # 临时指定环境
  python scripts/init_cloud.py --refresh-token             # 强制换新 access_token

前置：项目根 .env 里要有 WX_APP_SECRET（.env 已 gitignore）。
     AppID 自动从 project.config.json 读，环境 ID 自动从 miniprogram/config.js 读。

⚠️ AppSecret 是**小程序最高权限凭证**，只放本地 .env：
   不要写进小程序代码，也不要配到云函数环境变量里。
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wxcloud import Cloud, get_token, log, require_config, ROOT  # noqa: E402

MANIFEST = os.path.join(ROOT, "assets", "db-indexes.json")
INIT_DB_JS = os.path.join(ROOT, "cloudfunctions", "init_db", "index.js")


def step(n, total, title):
    log()
    log(f"=== {n}/{total} {title} ===")


def load_manifest():
    if not os.path.isfile(MANIFEST):
        sys.exit(f"找不到清单 {MANIFEST}")
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def check_manifest_sync(manifest):
    """清单与 init_db/index.js 的粗粒度比对：每个集合的索引条数是否一致。

    不做精细解析（索引字段名在 JS 里是展示串），只抓「一边加了、另一边没加」
    这种最常见的漂移。
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


def need_indexes(specs):
    """该集合**应有**的索引总数（含云开发自动建的那两条）。

    云开发会给每个集合自动建 `_id_` 索引，并自动建 `_openid_1` 索引
    （默认权限「仅创建者可读写」要靠它）。清单里若本来就要求 `_openid_1`，
    它跟自动建的那条是同一个，不重复计。
    """
    auto_openid = 0 if any(s["name"] == "_openid_1" for s in specs) else 1
    return 1 + auto_openid + len(specs)


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

    manifest = load_manifest()
    collections, indexes = manifest["collections"], manifest["indexes"]

    appid, secret, env = require_config()
    appid = args.appid or appid
    secret = args.secret or secret
    env = args.env or env

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
    cloud = Cloud(token, env)

    step(2, TOTAL, "集合体检")
    existing = cloud.collections()
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
            r = cloud.create_collection(name)
            log(f"    {'✓' if r is None else '-'} {name}"
                + ("  已存在（竞态，忽略）" if r else ""))
        existing = cloud.collections()
        still = [n for n in missing if n not in existing]
        log(f"  → 复查：{'全部就绪' if not still else '仍缺 ' + ' / '.join(still)}")

    step(3, TOTAL, "索引体检")
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
        have, need = cur["index_count"], need_indexes(specs)
        log(f"  {coll:<14} 索引 {have}/{need}" + ("" if have >= need else "  ← 缺"))
        for s in specs:
            log(f"      · {s['name']:<42} {s['note']}")
        to_create.extend(specs)

    if args.apply and to_create and not args.skip_indexes:
        log()
        log("  建索引（幂等：已存在的会报 exists，视为通过）：")
        for s in to_create:
            r = cloud.create_index(s["collection"], s["name"], s["keys"], s["unique"])
            log(f"    {'✓' if r is None else '-'} {s['collection']}.{s['name']}"
                + ("  已存在（跳过）" if r else ""))
        existing2 = cloud.collections()
        log()
        log("  复查（索引数 / 应有）：")
        for coll, specs in plan.items():
            cur = existing2.get(coll)
            if not cur:
                continue
            have, need = cur["index_count"], need_indexes(specs)
            log(f"    {'✓' if have >= need else '✗'} {coll:<14} {have}/{need}")

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
