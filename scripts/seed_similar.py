#!/usr/bin/env python3
"""
seed_similar.py —— 把「形似词」写入云端 words 集合（words.similar 字段）

数据从哪来：assets/word_lists/ielts-full-similar.json（由 gen_similar.py 产出，
            离线编辑距离计算，规则见该脚本头注释）。
写到哪：words 集合每个文档新增 similar 字段：
            similar: [{word, phonetic, meaning}, ...]   # 最多 3 条，按相似度降序
为什么单独一个脚本（不并进 seed_cloud.py）：
  · 形似词与「词表/音频/富化」三条线都无关，--reset 重导词表时不该被牵连；
  · 它是**逐词 update**（每个词的 similar 都不一样，没法批量同一 data），
    与 seed_cloud 的批量 add / 批量点亮是两种写法和两种失败语义；
  · 已跑过一次之后，改算法参数重跑 gen_similar + 本脚本 --force 即可，不必惊动词库。

幂等：
  · 默认只写**缺 similar 字段**的词（老数据半途失败的也能反复跑）；
  · --force 全部覆盖重写（改了距离参数、换了词表版本时用）。

用法：
  python scripts/seed_similar.py                  # 体检（只读，报告缺口）
  python scripts/seed_similar.py --apply          # 幂等补齐
  python scripts/seed_similar.py --apply --force  # 全部覆盖重写
  python scripts/seed_similar.py --workers 8      # 调并发（默认 4）

前置：项目根 .env 有 WX_APP_SECRET（AppID / 环境 ID 自动从项目文件读）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wxcloud import Cloud, CloudError, get_token, log, require_config, step  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIMILAR_FILE = os.path.join(ROOT, "assets", "word_lists", "ielts-full-similar.json")

ITER_CHUNK = 1000      # 单次 query 拉取条数（与 seed_cloud 一致）
PROGRESS_EVERY = 500   # 每写多少条报一次进度


def load_similar():
    if not os.path.isfile(SIMILAR_FILE):
        sys.exit(f"找不到 {os.path.relpath(SIMILAR_FILE, ROOT)}\n"
                 "先跑：python scripts/gen_similar.py")
    with open(SIMILAR_FILE, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not data:
        sys.exit("形似词清单格式不对或为空")
    for k, v in data.items():
        if not isinstance(v, list) or len(v) > 3:
            sys.exit(f"{k}: 形似词不是列表或超过 3 条")
    return data


def fetch_cloud_words(cloud):
    """拉云端全部词的 {word: _id}（只取两个字段，2987 词一页多一点）。"""
    out, skip = {}, 0
    while True:
        docs = cloud.query(f'db.collection("words").orderBy("seq","asc").skip({skip})'
                           f'.limit({ITER_CHUNK}).field({{word:true}}).get()')
        for d in docs:
            out[d["word"]] = d["_id"]
        skip += len(docs)
        if len(docs) < ITER_CHUNK:
            break
    return out


def update_one(cloud, word_id, similar):
    """逐词写 similar；网络抖动重试一次，仍失败抛给调用方记入失败清单。"""
    sim_json = json.dumps(similar, ensure_ascii=False)
    q = ('db.collection("words").doc("' + word_id + '")'
         '.update({data:{similar:' + sim_json + '}})')
    try:
        cloud.update(q)
    except CloudError:
        time.sleep(1)
        cloud.update(q)


def main():
    ap = argparse.ArgumentParser(description="把形似词写入云端 words.similar")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只体检）")
    ap.add_argument("--force", action="store_true", help="忽略已有字段，全部覆盖重写")
    ap.add_argument("--workers", type=int, default=4, help="并发写线程数（默认 4）")
    args = ap.parse_args()

    similar = load_similar()
    log(f"本地清单：{len(similar)} 词有形似词数据")

    appid, secret, env = require_config()
    token, note = get_token(appid, secret)
    cloud = Cloud(token, env)
    log(f"环境 {env}（token {note}）")

    step("拉取云端词表")
    cloud_words = fetch_cloud_words(cloud)
    log(f"  云端 words {len(cloud_words)} 条")

    # 对账：云端有而本地没有的（将来经 seed_words 导入的新词）→ 只能跳过并提醒
    only_cloud = sorted(set(cloud_words) - set(similar))
    if only_cloud:
        log(f"  ⚠️ {len(only_cloud)} 词在云端但不在本地清单（将不写 similar）："
            f"{only_cloud[:5]}...")
        log("     这些词应是后导入的；如需覆盖，先更新词表再重跑 gen_similar.py")

    if not args.apply:
        step("体检（只读）")
        have = cloud.query_total(
            'db.collection("words").where({similar: db.command.exists(true)}).count()')
        cover = sum(1 for w in cloud_words if w in similar)
        log(f"  已有 similar 字段：{have} / {len(cloud_words)}")
        log(f"  本地清单可覆盖：{cover}")
        log(f"  待补写：约 {max(0, cover - have)} 词（集合差，未逐词拉取）")
        log("  加 --apply 执行写入；--apply --force 可全部覆盖重写")
        return

    if args.force:
        # 覆盖写：本地清单里云端有的全写
        targets = [(w, cloud_words[w]) for w in similar if w in cloud_words]
    else:
        # 幂等写：拉一遍已有字段的词作差，只补缺口
        step("查缺口")
        have = cloud.query_total(
            'db.collection("words").where({similar: db.command.exists(true)}).count()')
        log(f"  已有 similar：{have} 词")
        exist_words = set()
        skip = 0
        while True:
            docs = cloud.query(
                f'db.collection("words").where({{similar: db.command.exists(true)}})'
                f'.field({{word:true}}).skip({skip}).limit({ITER_CHUNK}).get()')
            for d in docs:
                exist_words.add(d["word"])
            skip += len(docs)
            if len(docs) < ITER_CHUNK:
                break
        targets = [(w, cloud_words[w]) for w in similar
                   if w in cloud_words and w not in exist_words]
        log(f"  待补写：{len(targets)} 词")

    if not targets:
        log("  没有需要写入的词，收工")
        return

    step(f"写入 similar（{args.workers} 并发）")
    lock = threading.Lock()
    done = [0]
    failed = []
    t0 = time.time()

    def worker(word, wid):
        # 每线程独立 Cloud（独立 requests.Session，避免共享会话的线程安全问题）；
        # token 已获取一次，直接复用。
        c = Cloud(token, env)
        try:
            update_one(c, wid, similar[word])
        except Exception as e:  # noqa: BLE001
            with lock:
                failed.append((word, str(e)))
            return
        with lock:
            done[0] += 1
            n = done[0]
        if n % PROGRESS_EVERY == 0:
            el = time.time() - t0
            log(f"  {n}/{len(targets)}（耗时 {el:.0f}s，"
                f"预计还需 {el / n * (len(targets) - n):.0f}s）")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for word, wid in targets:
            pool.submit(worker, word, wid)
    # with 退出即全部完成

    el = time.time() - t0
    log(f"  ✓ 完成 {done[0]}/{len(targets)}，失败 {len(failed)}，耗时 {el:.0f}s")
    for w, e in failed[:10]:
        log(f"    ✗ {w}: {e}")
    if failed:
        sys.exit(f"有 {len(failed)} 条写入失败，重跑本脚本即可补齐（幂等）")

    step("复查")
    have = cloud.query_total(
        'db.collection("words").where({similar: db.command.exists(true)}).count()')
    log(f"  words 中带 similar 字段：{have} / {len(cloud_words)}")
    for probe in ("council", "stationary", "accommodate"):
        docs = cloud.query(
            f'db.collection("words").where({{word:"{probe}"}})'
            f'.field({{word:true,similar:true}}).limit(1).get()')
        if docs:
            sim = docs[0].get("similar") or []
            log(f"  {probe}: {[x['word'] for x in sim] or '（无）'}")


if __name__ == "__main__":
    main()
