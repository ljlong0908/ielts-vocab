#!/usr/bin/env python3
"""
gen_similar.py —— 为词表里每个词计算「形似词」（最多 3 个）

形似词 = 库里字形相近、容易记混的词（council/counsel、stationary/stationery）。
学习页在单词卡下方展示，帮用户**辨析**而非**混淆**。

为什么离线算、不运行时算：
  · 词表只有 2987 词，全量编辑距离本地约 30 秒，一次算永久用；
  · 运行时算（word_card 每次全表扫描）会把冷启动延迟转嫁给每次翻页；
  · AI 生成有幻觉风险（可能给出不在词表里的词，用户点不到、也学不了），
    且 2987 词成本不可控。
结果写入 assets/word_lists/ielts-full-similar.json，由 seed_similar.py 幂等播种。

算法（规则全部固化为下面的常量，改参数即改行为）：
  · 候选 = 全库除自身以外的词；长度差 > LEN_DIFF_MAX 直接跳过
  · 带状 Levenshtein，距离上限按词长分档：
      词长 <5 → 2；5–9 → 3；≥10 → 4
    （短词差一个字母已差异明显；长词要容纳 accommodate/accommodation 这类形态变体）
  · 排序键 = (距离, -公共前缀长度, seq)：越像排越前；seq 唯一 → 结果确定，重跑一致
  · 取前 SIMILAR_MAX 个

自检（任一不过即退出，不产出半成品）：
  · 输入词表 word 唯一、seq 连续（与 seed_cloud 同口径）
  · 每个词的形似词：不含自身、不重复、不超量、候选都在库内、音标非空

用法：
  python scripts/gen_similar.py                # 计算 + 自检 + 写出 + 打印样本
  python scripts/gen_similar.py --sample 20    # 多打印几个样本供人工过目
"""
import argparse
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORDS_FILE = os.path.join(ROOT, "assets", "word_lists", "ielts-full.json")
OUT_FILE = os.path.join(ROOT, "assets", "word_lists", "ielts-full-similar.json")

SIMILAR_MAX = 3        # 每个词最多列几个形似词（需求既定）
LEN_DIFF_MAX = 3       # 候选与目标的长度差上限
DIST_CAP_SHORT = 2     # 词长 < 5 的编辑距离上限
DIST_CAP_MID = 3       # 词长 5–9 的编辑距离上限
DIST_CAP_LONG = 4      # 词长 >= 10 的编辑距离上限


def log(msg=""):
    print(msg, flush=True)


def dist_cap(length):
    if length < 5:
        return DIST_CAP_SHORT
    if length < 10:
        return DIST_CAP_MID
    return DIST_CAP_LONG


def levenshtein(a, b, cap):
    """带状 Levenshtein：超过 cap 即早退返回 cap+1（不必算完整个矩阵）。

    正确性要点：带外格子必须填 sentinel（cap+1）而不是 0，
    否则 min() 会捡到未计算的 0，把远词误判成近距离（调试时真实踩过）。
    """
    big = cap + 1
    la, lb = len(a), len(b)
    if abs(la - lb) > cap:
        return big
    prev = [big] * (lb + 1)
    for j in range(min(cap, lb) + 1):
        prev[j] = j
    for i in range(1, la + 1):
        cur = [big] * (lb + 1)
        lo, hi = max(1, i - cap), min(lb, i + cap)
        if i <= cap:
            cur[0] = i
        for j in range(lo, hi + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            v = prev[j - 1] + cost
            if prev[j] + 1 < v:
                v = prev[j] + 1
            if cur[j - 1] + 1 < v:
                v = cur[j - 1] + 1
            cur[j] = v
        if min(cur) > cap:
            return big
        prev = cur
    d = prev[lb]
    return d if d <= cap else big


def common_prefix_len(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def similar_for(word, by_len, meta):
    """返回该词的形似词条目列表（已按相似度降序，含展示字段）。"""
    w = word.lower()
    L = len(w)
    cap = dist_cap(L)
    cands = []
    for dl in range(-LEN_DIFF_MAX, LEN_DIFF_MAX + 1):
        for other in by_len.get(L + dl, ()):
            if other == w:
                continue
            d = levenshtein(w, other, cap)
            if d > cap:
                continue
            m = meta[other]
            cands.append((d, -common_prefix_len(w, other), m["seq"], other, m))
    cands.sort()
    out = []
    for d, _neg_pref, _seq, other, m in cands[:SIMILAR_MAX]:
        out.append({
            "word": m["word"],
            "phonetic": m.get("phoneticUS") or m.get("phoneticUK") or "",
            "meaning": m.get("meaning", ""),
        })
    return out


def self_check(words, result):
    """不过就 sys.exit —— 脏数据播种进云端，排查成本比本地高一个量级。"""
    errs = []
    if len(result) != len(words):
        errs.append(f"输出条数 {len(result)} != 输入 {len(words)}")
    for w in words:
        key = w["word"]
        lst = result.get(key)
        if lst is None:
            errs.append(f"{key}: 缺输出")
            continue
        if len(lst) > SIMILAR_MAX:
            errs.append(f"{key}: 形似词超量 {len(lst)}")
        seen = set()
        for it in lst:
            if it["word"] == key:
                errs.append(f"{key}: 形似词包含自身")
            if it["word"] in seen:
                errs.append(f"{key}: 形似词重复 {it['word']}")
            seen.add(it["word"])
            if it["word"] not in {x["word"].lower() for x in words}:
                errs.append(f"{key}: 形似词不在库内 {it['word']}")
            if not it["phonetic"]:
                errs.append(f"{key}: 形似词无音标 {it['word']}")
    if errs:
        for e in errs[:20]:
            log(f"  ✗ {e}")
        sys.exit(f"自检未过（{len(errs)} 处），已中止，不写出文件")
    no_phonetic = sum(1 for lst in result.values() for it in lst if not it["phonetic"])
    log(f"  ✓ 自检通过：{len(result)} 词，无自身/无重复/不超量/候选都在库内")
    if no_phonetic:
        log(f"  ⚠️ {no_phonetic} 条形似词音标为空（词表本身缺音标，展示时会留空）")


def main():
    ap = argparse.ArgumentParser(description="计算词表形似词")
    ap.add_argument("--sample", type=int, default=8, help="打印多少条样本供人工过目")
    args = ap.parse_args()

    with open(WORDS_FILE, encoding="utf-8") as f:
        words = json.load(f)
    if len({w["word"] for w in words}) != len(words):
        sys.exit("词表里存在重复的 word")
    seqs = [w["seq"] for w in words]
    if seqs != list(range(1, len(words) + 1)):
        sys.exit("词表 seq 不是连续的 1..N（与 seed_cloud 同口径）")

    # 预索引：按长度分桶 + 小写元数据（比较一律用小写，展示保留原样）
    by_len = {}
    meta = {}
    for w in words:
        lw = w["word"].lower()
        by_len.setdefault(len(lw), []).append(lw)
        meta[lw] = w

    t0 = time.time()
    result = {}
    for w in words:
        result[w["word"]] = similar_for(w["word"], by_len, meta)

    log(f"计算完成：{len(words)} 词，耗时 {time.time() - t0:.1f}s")
    dist = {0: 0, 1: 0, 2: 0, 3: 0}
    for lst in result.values():
        dist[len(lst)] += 1
    total = len(words)
    log(f"覆盖率：无形似词 {dist[0]}（{dist[0] / total * 100:.1f}%），"
        f"1 个 {dist[1]}，2 个 {dist[2]}，满 3 个 {dist[3]}")

    self_check(words, result)

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    log(f"  ✓ 写出 {os.path.relpath(OUT_FILE, ROOT)}")

    # 样本：确定性取样（隔 N 个取一个 + 固定种子打乱），供人工过目质量
    log("样本（人工过目用）：")
    step = max(1, len(words) // args.sample)
    shown = 0
    for i, w in enumerate(words):
        if i % step:
            continue
        lst = result[w["word"]]
        if lst:
            log(f"  {w['word']:<16} -> {', '.join(x['word'] for x in lst)}")
        else:
            log(f"  {w['word']:<16} -> （无）")
        shown += 1
        if shown >= args.sample:
            break


if __name__ == "__main__":
    main()
