#!/usr/bin/env python3
"""
backfill_queue_roots.py —— 给 daily_plans 里已存的题目队列补 roots 字段

背景（D15，2026-10-22）：练习页题干区的「词根拆解」走 build_questions.toClient()
下发 `roots`。但旧版云函数生成的队列（daily_plans.practiceQueue / reviewQueue /
extraRounds[].practiceQueue）里题目没有这个字段，而 build_questions 的复用分支
（`existing` 非空即原样返回）会继续Serve旧队列 → 前端拿不到 roots，词根区不渲染。
本脚本把缺口补上：按每题的 wordId 去 words 集合取 roots，写回题目。

为什么需要一个脚本而不是等新队列自然替换：
  build_questions 只读「今天」的计划；旧队列不清洗的话，当天剩下的题一直没词根。

⚠️ 写方式：逐题点路径 update（`practiceQueue.0.roots`），绝不整数组重写。
  submit_answer 落库是「读整个 queue → 改 passed/wrong → 写回整个 queue」，
  整数组重写会在用户正在答题时把它没读到的 passed/wrong 冲掉（丢答题进度）。
  点路径只碰 roots 一个字段；唯一残留窗口是「submit_answer 在我写之前读、
  在我写之后整数组写回」会把 roots 抹掉——脚本末尾复查，重跑即可收敛（幂等）。

幂等：
  · 默认只写**缺 roots 字段**（或字段不是数组）的题目，可反复跑；
  · --force 全部覆盖重写（words.roots 内容更新过时用）。

范围：
  · 默认只处理**今天**（东八区，与 build_questions 的 dateStr 同规则）的计划——
     build_questions 也只读今天的计划，历史日期的队列永远不会再被Serve；
  · --all-dates 处理全部计划（排查/兜底用）。

用法：
  python scripts/backfill_queue_roots.py                    # 体检（只读，报告缺口）
  python scripts/backfill_queue_roots.py --apply            # 幂等补齐
  python scripts/backfill_queue_roots.py --apply --force    # 全部覆盖重写
  python scripts/backfill_queue_roots.py --all-dates        # 连历史日期一起

前置：项目根 .env 有 WX_APP_SECRET（AppID / 环境 ID 自动从项目文件读）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wxcloud import Cloud, CloudError, get_token, log, require_config, step  # noqa: E402

# 队列字段路径：(plan 里的字段, 取队列的函数) —— extraRounds 要带组下标
WORD_CHUNK = 100        # words.where({_id: _.in([...])}) 单批条数
# ⚠️ HTTP databasequery 不带 .limit() 时默认只回 10 条（小程序 SDK 是 100）——
#    本脚本所有 .get() 一律带显式 limit，宁大勿小（seed_similar.py 同规矩）
PLAN_LIMIT = 100        # 单日期计划数上限（个人小程序一个日期几条）
PASSES = 3              # 写后复查不通过时的最大重跑轮数（应对 submit_answer 竞态）


def today_str():
    """东八区今天，与 build_questions 的 dateStr(0) 同规则。"""
    return (datetime.utcnow() + timedelta(hours=8)).strftime("%Y-%m-%d")


def queue_slots(plan):
    """展开一个计划里所有题目槽位：[(点路径前缀, 题目 dict), ...]。

    例：("practiceQueue.0", {...}) / ("extraRounds.0.practiceQueue.2", {...})
    """
    slots = []
    for field in ("practiceQueue", "reviewQueue"):
        queue = plan.get(field)
        if isinstance(queue, list):
            for i, q in enumerate(queue):
                if isinstance(q, dict):
                    slots.append((f"{field}.{i}", q))
    groups = plan.get("extraRounds")
    if isinstance(groups, list):
        for gi, g in enumerate(groups):
            if not isinstance(g, dict):
                continue
            queue = g.get("practiceQueue")
            if isinstance(queue, list):
                for i, q in enumerate(queue):
                    if isinstance(q, dict):
                        slots.append((f"extraRounds.{gi}.practiceQueue.{i}", q))
    return slots


def has_roots(q):
    return isinstance(q.get("roots"), list)


def fetch_roots_by_word(cloud, word_ids):
    """批量取 {wordId: roots}；云端没有 roots 字段的词按 [] 计（与 buildQuestion 的
    `w.roots || []` 一致）。"""
    out = {}
    ids = sorted(set(word_ids))
    for s in range(0, len(ids), WORD_CHUNK):
        chunk = ids[s:s + WORD_CHUNK]
        arr = ",".join(json.dumps(i) for i in chunk)
        docs = cloud.query(
            f'db.collection("words").where({{_id: db.command.in([{arr}])}})'
            f'.field({{_id:true,roots:true}}).limit({WORD_CHUNK}).get()')
        for d in docs:
            out[d["_id"]] = d.get("roots") if isinstance(d.get("roots"), list) else []
    return out


def update_one(cloud, plan_id, path, roots):
    """点路径写一道题的 roots；网络抖动重试一次，仍失败抛给调用方。"""
    roots_json = json.dumps(roots, ensure_ascii=False)
    q = ('db.collection("daily_plans").doc("' + plan_id + '")'
         '.update({data:{"' + path + '.roots":' + roots_json + '}})')
    try:
        cloud.update(q)
    except CloudError:
        time.sleep(1)
        cloud.update(q)


def scan(cloud, dates):
    """拉计划 → 返回 [(plan, slots)]；只保留有题目槽位的。"""
    out = []
    for date in dates:
        docs = cloud.query(
            f'db.collection("daily_plans").where({{date:"{date}"}})'
            f'.field({{practiceQueue:true,reviewQueue:true,extraRounds:true}})'
            f'.limit({PLAN_LIMIT}).get()')
        for d in docs:
            slots = queue_slots(d)
            if slots:
                out.append((d, slots))
    return out


def main():
    ap = argparse.ArgumentParser(description="给 daily_plans 题目队列补 roots 字段")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只体检）")
    ap.add_argument("--force", action="store_true", help="忽略已有字段，全部覆盖重写")
    ap.add_argument("--all-dates", action="store_true", help="连历史日期的计划一起处理")
    args = ap.parse_args()

    appid, secret, env = require_config()
    token, note = get_token(appid, secret)
    cloud = Cloud(token, env)
    log(f"环境 {env}（token {note}）")

    step("确定范围")
    dates = None if args.all_dates else [today_str()]
    if dates:
        log(f"  今天（东八区）：{dates[0]}（历史日期不会被 build_questions Serve，跳过；"
            f"要连它们一起处理加 --all-dates）")
    else:
        cnt = cloud.query_total(
            'db.collection("daily_plans").where({_id: db.command.exists(true)}).count()')
        log(f"  全部日期，共 {cnt} 份计划")

    plans = scan(cloud, dates)
    total_q = sum(len(slots) for _, slots in plans)
    if not total_q:
        log("  没有带题目队列的计划，收工")
        return
    log(f"  {len(plans)} 份计划、{total_q} 道题")

    # 汇总缺口（跨计划按 wordId 去重取 roots）
    gaps = []          # (plan_id, path, wordId)
    no_wordid = 0
    for plan, slots in plans:
        for path, q in slots:
            if not args.force and has_roots(q):
                continue
            wid = q.get("wordId")
            if not wid:
                no_wordid += 1
                continue
            gaps.append((plan["_id"], path, wid))
    if no_wordid:
        log(f"  ⚠️ {no_wordid} 道题没有 wordId，无法回填（数据异常，需人工看）")
    log(f"  待补写：{len(gaps)} 道题"
        + ("（--force 全覆盖）" if args.force else "（缺 roots 字段）"))

    if not gaps:
        log("  没有缺口，收工")
        return

    if not args.apply:
        step("体检（只读）")
        log("  加 --apply 执行写入")
        return

    step("拉取 words.roots")
    roots_by_word = fetch_roots_by_word(cloud, [wid for _, _, wid in gaps])
    missing_word = sorted({wid for _, _, wid in gaps} - set(roots_by_word))
    if missing_word:
        log(f"  ⚠️ {len(missing_word)} 个 wordId 在 words 里查不到（词被删过？）"
            f"：{missing_word[:5]}... 这些题将按 [] 写")

    step(f"写入 roots（{len(gaps)} 道题，逐题点路径）")
    failed = []
    done = 0
    t0 = time.time()
    for plan_id, path, wid in gaps:
        try:
            update_one(cloud, plan_id, path, roots_by_word.get(wid, []))
        except Exception as e:  # noqa: BLE001
            failed.append((plan_id, path, str(e)))
            continue
        done += 1
        if done % 20 == 0:
            log(f"  {done}/{len(gaps)}（耗时 {time.time() - t0:.0f}s）")
    log(f"  ✓ 写入 {done}/{len(gaps)}，失败 {len(failed)}，耗时 {time.time() - t0:.0f}s")
    for pid, path, e in failed[:10]:
        log(f"    ✗ {pid[:8]}… {path}: {e}")
    if failed:
        sys.exit(f"有 {len(failed)} 道题写失败，重跑本脚本即可补齐（幂等）")

    step("复查（写后重读，防 submit_answer 竞态抹写）")
    for p in range(PASSES):
        plans2 = scan(cloud, dates)
        still = 0
        for plan, slots in plans2:
            for _, q in slots:
                if not has_roots(q):
                    still += 1
        total2 = sum(len(slots) for _, slots in plans2)
        log(f"  第 {p + 1} 轮：带 roots 的题 {total2 - still}/{total2}")
        if still == 0:
            break
        # 还有缺口：把缺的再写一遍（幂等）。用户仍在答题导致整数组写回时才会走到这
        again = []
        for plan, slots in plans2:
            for path, q in slots:
                if not has_roots(q):
                    wid = q.get("wordId")
                    if wid:
                        again.append((plan["_id"], path, wid))
        if not again:
            break
        log(f"  竞态残留 {len(again)} 道，补写中……")
        roots_by_word = fetch_roots_by_word(cloud, [wid for _, _, wid in again])
        for plan_id, path, wid in again:
            try:
                update_one(cloud, plan_id, path, roots_by_word.get(wid, []))
            except Exception as e:  # noqa: BLE001
                log(f"    ✗ {path}: {e}")

    # 抽样看一眼（截图里那道题）
    for probe in ("legislation",):
        docs = cloud.query(
            f'db.collection("daily_plans").where({{date:"{today_str()}"}})'
            f'.field({{practiceQueue:true,reviewQueue:true,extraRounds:true}})'
            f'.limit({PLAN_LIMIT}).get()')
        for d in docs:
            for path, q in queue_slots(d):
                if q.get("wordId") and str(q.get("stem", "")).lower() == probe:
                    r = q.get("roots") or []
                    log(f"  抽样 {probe}（{path}）：roots {len(r)} 条"
                        f" → {[x.get('part') for x in r] or '（该词无词根）'}")


if __name__ == "__main__":
    main()
