#!/usr/bin/env python3
"""
build_wordlist.py —— 从 ECDICT 抽取雅思词表

数据源：ECDICT（https://github.com/skywind3000/ECDICT），MIT License，
        Copyright (c) 2025 Linwei。可商用、可闭源衍生，需保留版权声明。
        许可证副本见 assets/word_lists/ECDICT-LICENSE.txt。

作用：把 ECDICT 中 `tag` 含 ielts 的词，清洗成 seed_words 云函数可直接消费的
      JSON 结构，输出到 assets/word_lists/。

用法：
  # 全量（排除中考/高考基础词，按 BNC 词频排序）
  python scripts/build_wordlist.py \
      --src /tmp/ecdict.csv \
      --out assets/word_lists/ielts-5000.json --limit 5000

  # 100 词试点
  python scripts/build_wordlist.py \
      --src /tmp/ecdict.csv \
      --out assets/word_lists/pilot-100.json --limit 100

  # 想要"完整雅思词表"（含 in/the 这类最基础词），关掉排除：
  python scripts/build_wordlist.py --src ... --out ... --exclude-tags ""

输出结构（数组，可直接作为 seed_words 的 words 入参）：
  [{ "word","phoneticUK","phoneticUS","pos","meaning","seq","level","source" }]

⚠️ 不使用 ECDICT 自带的 `audio` 字段——那是第三方词典的音频 URL，
   引用会把版权风险搬回来。音频一律由 scripts/gen_audio.py 本地生成。
"""
import argparse
import csv
import json
import os
import re
import sys

# 引擎/云函数对文本的限制：audio_cache 云函数的 TEXT_RE 为
# ^[A-Za-z][A-Za-z'\u2019\- ]{0,39}$ —— 这里保持一致，避免出现"有词无音"。
WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'\u2019\- ]{0,39}$")

# 同形异音词（heteronym）：孤立单词喂给 TTS 容易读错词性对应的读音，需人工抽检。
HOMOGRAPHS = {
    "record", "present", "lead", "desert", "use", "close", "live", "wind",
    "bow", "tear", "bass", "minute", "object", "produce", "project",
    "refuse", "reject", "subject", "content", "contract", "contrast",
    "convert", "convict", "decrease", "increase", "insult", "permit",
    "progress", "protest", "rebel", "recall", "suspect", "transfer",
    "transport", "wound", "row", "sow", "excuse", "abuse", "conduct",
}


def norm_phonetic(p):
    p = (p or "").strip()
    if not p:
        return ""
    if p.startswith("/") and p.endswith("/"):
        return p
    return f"/{p.strip('/')}/"


def norm_meaning(t):
    """ECDICT 的 translation 用字面量 \\n 分隔义项，转为全角分号。"""
    t = (t or "").replace("\\n", "；").replace("\r", "；").replace("\n", "；")
    t = re.sub(r"；{2,}", "；", t).strip("； ")
    return t[:160]


def norm_pos(pos):
    """ECDICT 的 pos 形如 'n:46/v:54'（词性:词频占比），转成 'n./v.'。"""
    pos = (pos or "").strip()
    if not pos:
        return ""
    parts = []
    for seg in pos.split("/"):
        key = seg.split(":")[0].strip()
        if key and key not in parts:
            parts.append(key)
    return "/".join(f"{k}." for k in parts)


def freq_key(row, order):
    """词频排名，越小越常用；缺失的排到最后。

    默认按 BNC 排序：ECDICT 的 frq 是当代新闻语料词频，会把 guy / york / hell
    这类口语新闻词排到最前；BNC 覆盖书面与学术体裁，排序结果更贴近雅思场景
    （实测首位从 program/guy 变为 council/establish/scheme/provision）。
    """
    for field in order:
        try:
            n = int(str(row.get(field) or "").strip() or 0)
            if n > 0:
                return n
        except (TypeError, ValueError):
            continue
    return 10 ** 9


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="ECDICT 的 ecdict.csv 路径")
    ap.add_argument("--out", required=True, help="输出 JSON 路径")
    ap.add_argument("--limit", type=int, default=5000, help="取词数量，默认 5000")
    ap.add_argument("--tag", default="ielts", help="考试标签，默认 ielts")
    ap.add_argument("--exclude-tags", default="zk,gk",
                    help="排除含这些标签的词（低于雅思水平的基础词），默认 zk,gk；传空串则不过滤")
    ap.add_argument("--sort", default="bnc", choices=["bnc", "frq"],
                    help="按哪个词频字段排序，默认 bnc（更贴近学术体裁）")
    ap.add_argument("--allow-phrases", action="store_true",
                    help="允许含空格的词组（默认只要单个单词，TTS 更稳）")
    args = ap.parse_args()

    if not os.path.isfile(args.src):
        sys.exit(f"找不到源文件：{args.src}")

    excl = [t.strip().lower() for t in (args.exclude_tags or "").split(",") if t.strip()]
    sort_order = ("bnc", "frq") if args.sort == "bnc" else ("frq", "bnc")

    rows, scan = [], 0
    skip = {"no_tag": 0, "basic": 0, "no_phonetic": 0, "no_meaning": 0,
            "bad_chars": 0, "phrase": 0}

    with open(args.src, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            sys.exit("源文件没有表头，无法解析")
        for r in reader:
            scan += 1
            tags = (r.get("tag") or "").lower().split()
            if args.tag not in tags:
                skip["no_tag"] += 1
                continue
            # 排除中考/高考等基础词：给雅思考生出 "in / the" 没有意义
            if excl and any(t in tags for t in excl):
                skip["basic"] += 1
                continue
            word = (r.get("word") or "").strip()
            if not WORD_RE.match(word):
                skip["bad_chars"] += 1
                continue
            if " " in word and not args.allow_phrases:
                skip["phrase"] += 1
                continue
            if word[0].isupper():          # 排除专有名词/缩写
                skip["bad_chars"] += 1
                continue
            phone = norm_phonetic(r.get("phonetic"))
            if not phone:
                skip["no_phonetic"] += 1
                continue
            meaning = norm_meaning(r.get("translation"))
            if not meaning:
                skip["no_meaning"] += 1
                continue
            rows.append({
                "word": word.lower(),
                "phoneticUK": phone,
                "phoneticUS": phone,       # ECDICT 主要提供英式音标，美音留同值
                "pos": norm_pos(r.get("pos")),
                "meaning": meaning,
                "level": 1,
                "source": f"ecdict-{args.tag}",
                "_freq": freq_key(r, sort_order),
            })

    # 按词频排序（最常用优先），同名去重
    seen, picked = set(), []
    for r in sorted(rows, key=lambda x: x["_freq"]):
        if r["word"] in seen:
            continue
        seen.add(r["word"])
        picked.append(r)
        if len(picked) >= args.limit:
            break

    out = []
    for i, r in enumerate(picked, 1):
        r.pop("_freq", None)
        r["seq"] = i
        out.append(r)

    outdir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(outdir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    # 同形异音词清单单独留出，供人工抽检读音（文件名跟随输出名，避免互相覆盖）
    stem = os.path.splitext(os.path.basename(args.out))[0]
    hits = [w["word"] for w in out if w["word"] in HOMOGRAPHS]
    if hits:
        hpath = os.path.join(outdir, f"{stem}-homographs.json")
        with open(hpath, "w", encoding="utf-8") as f:
            json.dump(hits, f, ensure_ascii=False, indent=2)

    print(f"扫描 {scan} 行 → tag={args.tag} 且全部合格 {len(rows)} 词（排序键：{args.sort}）")
    print(f"  跳过：无 {args.tag} 标签 {skip['no_tag']} / 基础词({'/'.join(excl) or '未启用'}) {skip['basic']}"
          f" / 无音标 {skip['no_phonetic']} / 无释义 {skip['no_meaning']}"
          f" / 非法字符或专名 {skip['bad_chars']} / 词组 {skip['phrase']}")
    print(f"按词频取前 {len(out)} 词 → {args.out}")
    if len(out) < args.limit:
        print(f"  ℹ️ 只有 {len(out)} 词达标（不足 {args.limit}）——ECDICT 中符合条件的就是这么多")
    if out:
        avg = sum(len(w["meaning"]) for w in out) // len(out)
        print(f"  平均释义长度 {avg} 字")
        print("  前 10 词：")
        for w in out[:10]:
            print(f"    {w['seq']:>3}. {w['word']:<16} {w['phoneticUK']:<18} {w['meaning'][:32]}")
    if hits:
        print(f"  ⚠️ 含同形异音词 {len(hits)} 个（读音需人工抽检）→ {stem}-homographs.json")
        print(f"     {', '.join(hits[:15])}{' ...' if len(hits) > 15 else ''}")


if __name__ == "__main__":
    main()
