#!/usr/bin/env python3
"""
seed_cloud.py —— 在**本地**一次性完成小程序的全部「初始化数据」

覆盖范围（也就是说：跑完这一个脚本，云端数据就齐了，不用再进控制台点「云端测试」）：

  1. 词表      assets/word_lists/ielts-full.json        → words 集合（2987 词，seq 1..N）
  2. 富化      assets/examples/pilot-100-examples.json  → words 的 example / roots / etymology
  3. 单词音频  build/audio/manifest.json                → 云存储 + audio_cache
  4. 例句音频  build/sentence_audio/manifest.json       → 云存储 + audio_cache
  5. 出词就绪  把已有音频的单词 words.audioReady 置 true（只有 true 的词会进学习流程）

全程走微信云开发 HTTP API（见 wxcloud.py），因此**可以重复执行**：
  · 词表按 word 去重，只补缺的
  · 音频按 (text, type) 去重，已入 audio_cache 的默认跳过
  · audioReady / 富化字段都是幂等写入

用法：
  python scripts/seed_cloud.py                  # 体检（只读，不改云端）
  python scripts/seed_cloud.py --apply          # 幂等补齐
  python scripts/seed_cloud.py --apply --reset  # ⚠️ 先清空词库再全量导入（换词表版本时用）
  python scripts/seed_cloud.py --apply --skip-audio         # 只导词表与富化
  python scripts/seed_cloud.py --apply --force-audio        # 音频全部重传（云存储被误删时用）

⚠️ --reset 会清空 words / user_words / records / daily_plans 并把出词游标归零
   （checkins 打卡记录与 audio_cache 保留）——不可撤销，执行前请确认。

前置：项目根 .env 有 WX_APP_SECRET（AppID / 环境 ID 自动从项目文件读）。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wxcloud import (  # noqa: E402
    ROOT, Cloud, CloudError, get_token, log, require_config, step,
)

WORDS_FILE = os.path.join(ROOT, "assets", "word_lists", "ielts-full.json")
PILOT_FILE = os.path.join(ROOT, "assets", "word_lists", "pilot-100.json")
EXAMPLES_FILE = os.path.join(ROOT, "assets", "examples", "ielts-full-examples.json")
AUDIO_MANIFEST = os.path.join(ROOT, "build", "audio", "manifest.json")
SENTENCE_MANIFEST = os.path.join(ROOT, "build", "sentence_audio", "manifest.json")

WORD_TYPE = 2          # 2 = 美音（与本项目 gen_* 脚本的 --types us 一致）
SERVER_DATE = "__SERVER_DATE__"   # 占位符，拼进 query 前替换成 JS 的 new Date()
ADD_BATCH = 50         # 单次 databaseadd 的文档数
MARK_CHUNK = 50        # 单次 where(word in ...).update 的词数
ITER_CHUNK = 1000      # 单次 query 拉取条数

PURGE_TARGETS = ["words", "user_words", "records", "daily_plans"]


# ---------------------------------------------------------------- 读本地数据包

def load_json(path):
    if not os.path.isfile(path):
        sys.exit(f"找不到 {os.path.relpath(path, ROOT)}（先跑生成该文件的脚本）")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_local():
    """把词表、例句富化、两份音频清单读进来，并做完自检。"""
    words = load_json(WORDS_FILE)
    examples = {e["word"]: e for e in load_json(EXAMPLES_FILE)}
    word_audio = load_json(AUDIO_MANIFEST)
    sent_audio = load_json(SENTENCE_MANIFEST)
    pilot = load_json(PILOT_FILE)

    # --- 自检：词表 seq 必须从 1 连续到底（wordCursor 按 seq 推进，断号会卡出词）
    seqs = [w["seq"] for w in words]
    if seqs != list(range(1, len(words) + 1)):
        sys.exit(f"词表 seq 不是连续的 1..{len(words)}，请先跑 build_wordlist.py")
    if len({w["word"] for w in words}) != len(words):
        sys.exit("词表里存在重复的 word")

    # --- 自检：例句音频的句子必须与富化内容一一对应（否则音频与显示会对不上）
    ex_sent = {e["word"]: e["example"]["en"] for e in examples.values()}
    mismatch = [m["word"] for m in sent_audio
                if m["word"] in ex_sent and m["text"].strip() != ex_sent[m["word"]].strip()]
    if mismatch:
        sys.exit(f"例句音频与 pilot 例句文本不一致：{mismatch[:5]}（重新跑 gen_sentence_audio.py）")

    missing = [m["word"] for m in word_audio if m["word"] not in {w["word"] for w in words}]
    if missing:
        sys.exit(f"音频 manifest 里有词表里没有的词：{missing[:5]}")

    return words, examples, word_audio, sent_audio, pilot


# ---------------------------------------------------------------- 组装 words 文档

def build_doc(w, ex):
    """按 seed_words 云函数的字段口径造一条 words 文档；pilot 词额外带上富化内容。"""
    doc = {
        "word": w["word"],
        "phoneticUK": w.get("phoneticUK", ""),
        "phoneticUS": w.get("phoneticUS", ""),
        "pos": w.get("pos", ""),
        "meaning": w.get("meaning", ""),
        "seq": w["seq"],
        "level": w.get("level", 1),
        "source": w.get("source", "seed"),
        # 发音音频是否就绪：默认 false，等下面「点亮」步骤按实际入缓存的情况置 true。
        # start_new_words 只取 audioReady=true 的词，故未点亮的词不会进学习流程。
        "audioReady": False,
        "roots": [],
        "etymology": "",
        "enriched": False,
        "enrichStatus": "pending",
        "enrichLockAt": None,
        "createdAt": SERVER_DATE,
    }
    if ex:
        doc["example"] = ex["example"]
        doc["roots"] = ex.get("roots", [])
        doc["etymology"] = ex.get("etymology", "")
        doc["enriched"] = True
        doc["enrichStatus"] = "ok"
        doc["enrichError"] = ""
        doc["enrichedAt"] = SERVER_DATE
    return doc


def to_query(docs_json):
    """docs_json（已是 JSON 串）→ add 语句，并把日期占位符换回 JS 表达式。"""
    return ('db.collection("words").add({data:'
            + docs_json + '})').replace(f'"{SERVER_DATE}"', "new Date()")


# ---------------------------------------------------------------- 各步骤

def fetch_cloud_words(cloud):
    """拉云端全部词的 {word: {_id, seq, enriched}}。"""
    out, skip = {}, 0
    while True:
        docs = cloud.query(f'db.collection("words").orderBy("seq","asc").skip({skip})'
                           f'.limit({ITER_CHUNK}).field({{word:true,seq:true,enriched:true}}).get()')
        for d in docs:
            out[d["word"]] = d
        skip += len(docs)
        if len(docs) < ITER_CHUNK:
            break
    return out


def backup(cloud, names):
    """把待清空的集合整体导出到 build/backup/，给不可撤销的操作留一份后悔药。"""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    outdir = os.path.join(ROOT, "build", "backup")
    os.makedirs(outdir, exist_ok=True)
    out = []
    for name in names:
        docs, skip = [], 0
        while True:
            page = cloud.query(f'db.collection("{name}").skip({skip}).limit({ITER_CHUNK}).get()')
            docs += page
            skip += len(page)
            if len(page) < ITER_CHUNK:
                break
        path = os.path.join(outdir, f"{name}-{stamp}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False, indent=2)
        out.append((name, len(docs), path))
    return out


def do_reset(cloud):
    step("重置词库（--reset）")
    log("  会清空：" + " / ".join(PURGE_TARGETS) + "，并把 users.wordCursor 归零")
    log("  保留：" + "checkins（打卡）/ audio_cache（音频索引）/ users（账号与统计）")

    log("  先备份到 build/backup/：")
    for name, n, path in backup(cloud, PURGE_TARGETS):
        log(f"    ✓ {name:<14} {n} 条 → {os.path.relpath(path, ROOT)}")

    for name in PURGE_TARGETS:
        n = cloud.purge(name)
        log(f"  ✓ {name:<14} 删除 {n} 条")
    r = cloud.update('db.collection("users").where({wordCursor: db.command.gt(0)})'
                     '.update({data:{wordCursor:0,updatedAt:new Date()}})')
    log(f"  ✓ users.wordCursor 归零（{r.get('modified', r.get('matched', 0))} 个用户）")


def do_words(cloud, words, examples):
    step("导入词表")
    existing = fetch_cloud_words(cloud)
    log(f"  云端已有 {len(existing)} 词，本地词表 {len(words)} 词")

    todo = [w for w in words if w["word"] not in existing]
    log(f"  待新增 {len(todo)} 词"
        + (f"，另有 {len(words) - len(todo)} 词已存在（跳过，不覆盖）" if existing else ""))

    if not todo:
        return 0

    inserted = 0
    for i in range(0, len(todo), ADD_BATCH):
        chunk = todo[i:i + ADD_BATCH]
        docs = [build_doc(w, examples.get(w["word"])) for w in chunk]
        cloud.add(to_query(json.dumps(docs, ensure_ascii=False)))
        inserted += len(chunk)
        log(f"    {inserted}/{len(todo)}  {chunk[0]['word']} … {chunk[-1]['word']}")
    return inserted


def do_enrich(cloud, examples):
    """把云端还没富化的词补上 example / roots / etymology（全量）。

    原先是给 pilot-100 写的（一次 where(word in [...]) 就能拉完），
    全量近 3000 词必须改成「分页拉取未富化词 → 逐个 doc().update() 写回」，
    否则单次 in 数组过大且 query 默认只返回一页，会静默漏词。
    """
    step("补齐例句与词根（全量）")
    existing = fetch_cloud_words(cloud)   # {word: {_id, seq, enriched}}
    todo = [d for w, d in existing.items()
            if d.get("enriched") is not True and w in examples]
    skipped = len(existing) - len(todo)

    if not todo:
        log(f"  ✓ 云端 {len(existing)} 词均已富化，无需处理")
        return 0

    log(f"  云端 {len(existing)} 词 | 本地富化内容 {len(examples)} 条 | 待补 {len(todo)} 词"
        + (f" | 已富化跳过 {skipped}" if skipped else ""))
    log(f"  开始写回 …")
    done = 0
    for d in todo:
        ex = examples[d["word"]]
        data = {
            "example": ex["example"],
            "roots": ex.get("roots", []),
            "etymology": ex.get("etymology", ""),
            "enriched": True,
            "enrichStatus": "ok",
            "enrichError": "",
            "enrichedAt": SERVER_DATE,
        }
        q = ('db.collection("words").doc("' + d["_id"] + '").update({data:'
             + json.dumps(data, ensure_ascii=False) + '})')
        cloud.update(q.replace(f'"{SERVER_DATE}"', "new Date()"))
        done += 1
        if done % 200 == 0 or done == len(todo):
            log(f"    {done}/{len(todo)}")
    log(f"  ✓ 补齐 {len(todo)} 词")
    return len(todo)


def fetch_audio_cache(cloud):
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


def do_audio(cloud, word_audio, sent_audio, force=False):
    """上传音频到云存储并写 audio_cache。返回成功入缓存的 word 列表。"""
    step("上传音频并写 audio_cache")
    cache = fetch_audio_cache(cloud)
    log(f"  audio_cache 已有 {len(cache)} 条")

    jobs = []
    for m in word_audio:
        jobs.append(("word", m["word"], m["type"], m["file"], m))
    for m in sent_audio:
        jobs.append(("sentence", m["text"], m["type"], m["file"], m))

    uploaded, skipped, failed = 0, 0, []
    ok_words = []
    t0 = None
    for idx, (kind, key, atype, rel, m) in enumerate(jobs, 1):
        cache_key = (key, atype)
        if cache_key in cache and not force:
            skipped += 1
            if kind == "word":
                ok_words.append(key)
            continue

        base = AUDIO_MANIFEST if kind == "word" else SENTENCE_MANIFEST
        local = os.path.join(os.path.dirname(base), rel)
        if not os.path.isfile(local):
            failed.append(f"{rel}（本地文件缺失）")
            continue

        with open(local, "rb") as f:
            data = f.read()

        cloud_path = f"audio/{atype}/{os.path.basename(rel)}"
        try:
            file_id = cloud.upload(cloud_path, data)
        except CloudError as e:
            failed.append(f"{cloud_path}：{e}")
            continue

        doc = {
            "text": key, "type": atype, "fileID": file_id, "source": "preseed",
            "bytes": len(data), "kind": kind,
        }
        if cache_key in cache:
            cloud.update('db.collection("audio_cache").doc("%s").update({data:%s})'
                         % (cache[cache_key], json.dumps(doc, ensure_ascii=False)))
        else:
            cloud.add('db.collection("audio_cache").add({data:%s})'
                      % json.dumps(dict(doc, createdAt=SERVER_DATE), ensure_ascii=False)
                      .replace(f'"{SERVER_DATE}"', "new Date()"))
            cache[cache_key] = "new"

        uploaded += 1
        if kind == "word":
            ok_words.append(key)

        if uploaded % 10 == 0 or idx == len(jobs):
            log(f"    {idx}/{len(jobs)}  新传 {uploaded}  跳过 {skipped}  失败 {len(failed)}")

    log(f"  ✓ 新上传 {uploaded}，跳过 {skipped}，失败 {len(failed)}")
    for e in failed[:10]:
        log(f"    ✗ {e}")
    return ok_words, failed


def do_mark(cloud, ok_words):
    """把已入音频缓存的单词在 words 里置 audioReady=true（出词的前提）。"""
    step("点亮 audioReady")
    if not ok_words:
        log("  - 没有可点亮的词，跳过")
        return 0
    marked = 0
    for i in range(0, len(ok_words), MARK_CHUNK):
        chunk = ok_words[i:i + MARK_CHUNK]
        arr = ",".join(json.dumps(w) for w in chunk)
        r = cloud.update(
            f'db.collection("words").where({{word: db.command.in([{arr}]), '
            f'audioReady: db.command.neq(true)}}).update({{data:{{audioReady:true, '
            f'audioReadyAt: new Date()}}}})')
        marked += r.get("modified", 0)
    log(f"  ✓ 新点亮 {marked} 词（本轮涉及 {len(ok_words)} 词）")
    return marked


def report(cloud, words, ok_words):
    step("复查")
    total = cloud.count("words")
    ready = cloud.query_total('db.collection("words").where({audioReady:true}).count()')
    cache = cloud.count("audio_cache")
    log(f"  words        {total} 条（本地词表 {len(words)}）  audioReady=true  {ready} 条")
    log(f"  audio_cache  {cache} 条")
    for name in ("users", "user_words", "records", "daily_plans", "checkins"):
        log(f"  {name:<12} {cloud.count(name)} 条")

    first = cloud.query('db.collection("words").where({audioReady:true})'
                        '.orderBy("seq","asc").limit(5).field({word:true,seq:true}).get()')
    log("  最先出词的 5 个：" + "、".join(f"{d['word']}(seq {d['seq']})" for d in first))

    if total != len(words):
        log(f"  ⚠️ 云端词数 {total} 与本地词表 {len(words)} 不一致"
            "（多半是导过旧词表——用 --reset 重来一遍）")
    if ready == 0:
        log("  ⚠️ 没有任何 audioReady 的词，学习流程会取不到词")
    elif len(ok_words) and ready < 100:
        log(f"  ⚠️ audioReady 只有 {ready} 个，少于预期的 100，检查音频是否有上传失败")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="本地初始化云数据库的全部数据")
    ap.add_argument("--apply", action="store_true", help="真正执行（默认只体检）")
    ap.add_argument("--reset", action="store_true",
                    help="⚠️ 先清空词库（words/user_words/records/daily_plans）再导入")
    ap.add_argument("--skip-words", action="store_true", help="跳过词表与富化")
    ap.add_argument("--skip-audio", action="store_true", help="跳过音频上传与点亮")
    ap.add_argument("--force-audio", action="store_true", help="音频全部重传，不跳过已缓存的")
    ap.add_argument("--appid", default="")
    ap.add_argument("--env", default="")
    ap.add_argument("--secret", default="")
    ap.add_argument("--refresh-token", action="store_true")
    args = ap.parse_args()

    appid, secret, env = require_config()
    appid = args.appid or appid
    secret = args.secret or secret
    env = args.env or env

    log(f"项目根      {ROOT}")
    log(f"AppID       {appid or '（未找到）'}")
    log(f"云环境 ID   {env or '（未找到）'}")
    log(f"模式        {'★ 执行' if args.apply else '体检（只读）'}"
        + ("  +reset" if args.reset else ""))

    if not appid:
        sys.exit("\n缺少 AppID：检查 project.config.json")
    if not env:
        sys.exit("\n缺少云环境 ID：检查 miniprogram/config.js 的 ENV_ID")
    if not secret:
        sys.exit("\n缺少 AppSecret：在项目根 .env 里加一行\n    WX_APP_SECRET=...")

    words, examples, word_audio, sent_audio, pilot = load_local()
    log(f"本地词表    {len(words)} 词（seq 1..{len(words)}）")
    log(f"富化例句    {len(examples)} 条")
    log(f"音频        单词 {len(word_audio)} 个 / 例句 {len(sent_audio)} 个")

    if not args.apply and args.reset:
        sys.exit("\n--reset 必须与 --apply 一起用（单独用不会改动任何数据）")

    if not args.apply:
        log()
        log("—— 以上为本地数据包概览，云端未被改动。确认后加 --apply 执行。")
        return

    token, how = get_token(appid, secret, refresh=args.refresh_token)
    step("连接云环境")
    log(f"  ✓ access_token {how}")
    cloud = Cloud(token, env)

    if args.reset:
        do_reset(cloud)

    if not args.skip_words:
        do_words(cloud, words, examples)
        do_enrich(cloud, examples)

    ok_words = []
    if not args.skip_audio:
        ok_words, _ = do_audio(cloud, word_audio, sent_audio, force=args.force_audio)
        do_mark(cloud, ok_words)

    report(cloud, words, ok_words)

    log()
    log("—— 数据初始化完成。")
    log()
    log("⚠️ 还剩一步只能手工：集合的**安全规则**")
    log("   云开发控制台 → 数据库 → 选集合 → 权限设置")
    log("     words      → 所有用户可读，仅管理端可写")
    log("     其余 6 个  → 仅创建者可读写")
    log("   另外确认：设置里「未登录用户访问云资源」= 关闭。")


if __name__ == "__main__":
    main()
