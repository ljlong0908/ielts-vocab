#!/usr/bin/env python3
"""
seed_quote_audio.py —— 上传「每日一句」音频到云存储，并写 audio_cache 索引

为什么单独一个脚本：
  每日一句（M12）是纯前端静态语料（miniprogram/utils/quotes.js），首页喇叭
  走的是**例句音频链路**：audio.js playSentence → audio_cache(kind='sentence')。
  而 audio_cache 对例句**只读不写**（不调第三方、不写云存储，见该函数头注释），
  所以这 12 句必须有音频**预先入库**，否则查不到 → playSentence 静默返回 →
  点喇叭没声音也不报错。

  它不属于 seed_cloud.py 的理由：那边的例句音频强绑定 pilot-100 例句
  （load_local() 会校验「音频 manifest 的句子 == 富化例句文本」，混进去会直接
  退出），而且每日一句与词表/词库毫无关系，不该被 --reset 之类的动作牵连。

音频从哪来（三步，本脚本是第 ③ 步）：
  ① python scripts/quotes_to_examples.py            quotes.js → quotes-12.json
  ② python scripts/gen_sentence_audio.py --examples assets/examples/quotes-12.json \
        --outdir build/quote_audio --types us        Kokoro 本地合成 mp3
  ③ python scripts/seed_quote_audio.py --apply      本脚本：上传 + 写索引

幂等：按 (text, type) 查 audio_cache，已存在则跳过（--force 可强制重传，
     例如换了音色要覆盖旧音频）。

用法：
  python scripts/seed_quote_audio.py            # 体检（只读，不改云端）
  python scripts/seed_quote_audio.py --apply    # 真正上传
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wxcloud import Cloud, CloudError, get_token, log, require_config, step  # noqa: E402
from text_key import hash_text  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "build", "quote_audio", "manifest.json")
ITER_CHUNK = 1000
SERVER_DATE = "__SERVER_DATE__"


# ------------------------------------------------- 与云端一致的两处算法

# ------------------------------------------------- 本地清单

def load_manifest():
    if not os.path.isfile(MANIFEST):
        sys.exit(f"找不到 {os.path.relpath(MANIFEST, ROOT)}\n"
                 "先跑：python scripts/quotes_to_examples.py\n"
                 "      python scripts/gen_sentence_audio.py --examples "
                 "assets/examples/quotes-12.json --outdir build/quote_audio --types us")
    with open(MANIFEST, encoding="utf-8") as f:
        rows = json.load(f)
    if not rows:
        sys.exit("manifest 是空的 —— 合成步骤没产出任何音频")

    # 自检①：文本必须是「字母开头、无控制字符/反斜杠/反引号」，否则云端
    # audio_cache 的 TEXT_RE_SENTENCE 会拒掉查询（查得到也读不出，白传）
    bad = [r["text"] for r in rows if not (r["text"][:1].isalpha()
                                           and len(r["text"]) <= 200
                                           and all(ord(c) > 31 and c not in "\\`"
                                                   for c in r["text"]))]
    if bad:
        sys.exit(f"有 {len(bad)} 句会被云端正则拒掉：{bad[:3]}")

    # 自检②：文件名 hash 必须等于按文本重算的 hash（三处算法漂移会静默错位）
    drift = [r["text"] for r in rows
             if os.path.basename(r["file"]) != f"s_{hash_text(r['text'])}.mp3"]
    if drift:
        sys.exit(f"有 {len(drift)} 条音频的 hash 与文本对不上（算法漂移？）：{drift[:2]}")

    # 自检③：本地文件必须真的在
    missing = [r["file"] for r in rows
               if not os.path.isfile(os.path.join(os.path.dirname(MANIFEST), r["file"]))]
    if missing:
        sys.exit(f"manifest 里 {len(missing)} 个音频文件本地不存在：{missing[:3]}")

    return rows


def fetch_cache(cloud):
    """拉 audio_cache，返回 {(text, type): _id}。"""
    out, skip = {}, 0
    while True:
        docs = cloud.query(f'db.collection("audio_cache").skip({skip}).limit({ITER_CHUNK})'
                           '.field({text:true,type:true}).get()')
        for d in docs:
            out[(d["text"], d.get("type"))] = d["_id"]
        skip += len(docs)
        if len(docs) < ITER_CHUNK:
            break
    return out


# ------------------------------------------------- 上传

def do_upload(cloud, rows, force=False):
    step("上传每日一句音频并写 audio_cache")
    cache = fetch_cache(cloud)
    log(f"  audio_cache 已有 {len(cache)} 条")

    uploaded, skipped, failed = 0, 0, []
    t0 = time.time()

    for idx, m in enumerate(rows, 1):
        key, atype = m["text"], m["type"]
        if (key, atype) in cache and not force:
            skipped += 1
            continue

        local = os.path.join(os.path.dirname(MANIFEST), m["file"])
        with open(local, "rb") as f:
            data = f.read()

        cloud_path = f"audio/{atype}/{os.path.basename(m['file'])}"
        try:
            file_id = cloud.upload(cloud_path, data)
        except CloudError as e:
            failed.append(f"{cloud_path}：{e}")
            continue

        doc = {
            "text": key, "type": atype, "fileID": file_id, "source": "preseed",
            "bytes": len(data), "kind": "sentence",
        }
        try:
            if (key, atype) in cache:
                cloud.update('db.collection("audio_cache").doc("%s").update({data:%s})'
                             % (cache[(key, atype)], json.dumps(doc, ensure_ascii=False)))
            else:
                cloud.add('db.collection("audio_cache").add({data:%s})'
                          % json.dumps(dict(doc, createdAt=SERVER_DATE), ensure_ascii=False)
                          .replace(f'"{SERVER_DATE}"', "new Date()"))
                cache[(key, atype)] = "new"
        except CloudError as e:
            failed.append(f"{cloud_path} 已传但写索引失败：{e}")
            continue

        uploaded += 1
        log(f"    [{idx}/{len(rows)}] ✓ {m['word']}  {key[:44]}"
            f"{'…' if len(key) > 44 else ''}  {len(data)} B")

    log(f"  ✓ 新上传 {uploaded}，跳过 {skipped}，失败 {len(failed)}（耗时 {time.time() - t0:.1f}s）")
    for e in failed[:10]:
        log(f"    ✗ {e}")
    return uploaded, skipped, failed


def verify(cloud, rows):
    step("复查：云端能否按 (text, type) 命中")
    cache = fetch_cache(cloud)
    miss = [m["text"] for m in rows if (m["text"], m["type"]) not in cache]
    log(f"  audio_cache 共 {cloud.count('audio_cache')} 条")
    log(f"  每日一句 {len(rows)} 句，命中 {len(rows) - len(miss)}，缺失 {len(miss)}")
    for t in miss[:5]:
        log(f"    ✗ 未命中：{t[:56]}")
    return not miss


# ------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="上传每日一句音频到云存储并写 audio_cache")
    ap.add_argument("--apply", action="store_true", help="真正执行（默认只体检）")
    ap.add_argument("--force", action="store_true", help="已缓存的也重传覆盖")
    ap.add_argument("--appid", default="")
    ap.add_argument("--env", default="")
    ap.add_argument("--secret", default="")
    ap.add_argument("--refresh-token", action="store_true")
    args = ap.parse_args()

    appid, secret, env = require_config()
    appid = args.appid or appid
    secret = args.secret or secret
    env = args.env or env

    rows = load_manifest()

    log(f"项目根      {ROOT}")
    log(f"AppID       {appid or '（未找到）'}")
    log(f"云环境 ID   {env or '（未找到）'}")
    log(f"模式        {'★ 执行' if args.apply else '体检（只读）'}"
        + ("  +force" if args.force else ""))
    log(f"本地清单    {len(rows)} 句（{sum(m['bytes'] for m in rows) / 1024:.0f} KB）")

    if not appid:
        sys.exit("\n缺少 AppID：检查 project.config.json")
    if not env:
        sys.exit("\n缺少云环境 ID：检查 miniprogram/config.js 的 ENV_ID")
    if not secret:
        sys.exit("\n缺少 AppSecret：在项目根 .env 里加一行\n    WX_APP_SECRET=...")

    if not args.apply:
        log()
        log("—— 本地清单体检通过，云端未被改动。确认后加 --apply 执行。")
        return

    token, how = get_token(appid, secret, refresh=args.refresh_token)
    step("连接云环境")
    log(f"  ✓ access_token {how}")
    cloud = Cloud(token, env)

    uploaded, skipped, failed = do_upload(cloud, rows, force=args.force)
    if uploaded:
        verify(cloud, rows)
    else:
        verify(cloud, rows)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
