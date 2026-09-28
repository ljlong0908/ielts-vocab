#!/usr/bin/env python3
"""
build_wordlist.py —— 从 ECDICT 抽取雅思词表

数据源：ECDICT（https://github.com/skywind3000/ECDICT），MIT License，
        Copyright (c) 2025 Linwei。可商用、可闭源衍生，需保留版权声明。
        许可证副本见 assets/word_lists/ECDICT-LICENSE.txt。

作用：把 ECDICT 中 `tag` 含 ielts 的词，清洗成 seed_words 云函数可直接消费的
      JSON 结构，输出到 assets/word_lists/。

用法：
  # 全量（排除中考/高考基础词，按 BNC 词频排序；默认不限条数）
  python scripts/build_wordlist.py \
      --src /tmp/ecdict.csv \
      --out assets/word_lists/ielts-full.json

  # 100 词试点（取词频最高的前 100 个）
  python scripts/build_wordlist.py \
      --src /tmp/ecdict.csv \
      --out assets/word_lists/pilot-100.json --limit 100

  # 想要"完整雅思词表"（含 in/the 这类最基础词），关掉排除：
  python scripts/build_wordlist.py --src ... --out ... --exclude-tags ""

输出结构（数组，可直接作为 seed_words 的 words 入参）：
  [{ "word","phoneticUK","phoneticUS","pos","meaning","seq","level","source" }]

文件名刻意不带词数：词表规模会随 ECDICT 版本与筛选规则变化（曾出现
"ielts-5000.json 里其实只有 3056 词"的名不副实问题），用具名反而要反复改名。

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

# 复数形式已是**独立词条**的词：语义与单数明显不同，单复数必须都保留。
# 不在这个名单里的规则复数（opportunities / contracts / tunnels …）会被丢弃 ——
# 复数拼写可由单数推导，对雅思学习没有增量价值，却会挤占词表额度、让列表显得臃肿。
# ⚠️ 新增例外前先确认：该复数是否真的不可由单数推得语义。
KEEP_PLURAL = {
    # 学科名词
    "economics", "statistics", "ethics", "politics", "physics", "mathematics",
    # 语义分化
    "odds",        # 单数 odd 是"奇怪的"，复数 odds 是"几率"
    "amends",      # make amends 是固定搭配，单数 amend 是动词"修正"
    "pants",       # 单数 pant 是"气喘"，与"裤子"无关
    "savings",     # 单数 saving 是"节约"，复数 savings 是"存款"
    "sales",       # 单数 sale 是"出售"，复数 sales 是"销售额"
    "means",       # 单数 mean 是"意味着"，means 是"手段"
    "premises",    # 单数 premise 是"前提"，复数 premises 是"房屋及地基"
    "contents",    # 单数 content 是"内容"，复数 contents 是"目录"
    "customs",     # 单数 custom 是"习俗"，复数 customs 是"海关"
    "goods",       # 单数 good 是"好的"，goods 是"商品"
    "manners",     # 单数 manner 是"方式"，复数 manners 是"礼貌"
    "quarters",    # 单数 quarter 是"四分之一"，复数 quarters 是"住处"
    "works",       # 复数可指"工厂/著作"
    "regards",     # 书信固定用语
    "terms",       # 复数可指"条款/交情"
    "ways",        # 复数可指"船台/习惯"
    # 单复数同形，避免被 -s 规则误删
    "news", "series", "species",
}


def singular_forms(word: str) -> list:
    """推测一个以 s 结尾的词的规则单数形式（-ies / -es / -s 三条规则）。

    只做规则还原，不做词典查询 —— 因此调用方必须用「候选集中确实存在该单数」
    来兜底，避免把 business / access 这类本身以 s 收尾的词误判。
    """
    out = []
    if word.endswith("ies") and len(word) > 4:
        out.append(word[:-3] + "y")     # studies -> study
    if word.endswith("es") and len(word) > 3:
        out.append(word[:-2])           # boxes -> box
        out.append(word[:-1])           # cases -> case
    if word.endswith("s") and len(word) > 2 and not word.endswith("ss"):
        out.append(word[:-1])           # tunnels -> tunnel
    return out


def is_redundant_plural(word: str, vocabulary: set) -> bool:
    """该词是否是「同源单数已在词表中」的冗余复数。"""
    if word in KEEP_PLURAL:
        return False
    if not word.endswith("s"):
        return False
    return any(s in vocabulary for s in singular_forms(word))


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
    ap.add_argument("--limit", type=int, default=0,
                    help="取词数量上限，0 表示不限（默认；ECDICT 里达标的词全要）")
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

    # 单复数同源去重（见 KEEP_PLURAL / is_redundant_plural 的说明）
    qualified = len(rows)
    vocabulary = {r["word"] for r in rows}
    dropped_plural = [r["word"] for r in rows if is_redundant_plural(r["word"], vocabulary)]
    if dropped_plural:
        dropped_set = set(dropped_plural)
        rows = [r for r in rows if r["word"] not in dropped_set]

    # 按词频排序（最常用优先），同名去重
    seen, picked = set(), []
    for r in sorted(rows, key=lambda x: x["_freq"]):
        if r["word"] in seen:
            continue
        seen.add(r["word"])
        picked.append(r)
        if args.limit and len(picked) >= args.limit:
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

    print(f"扫描 {scan} 行 → tag={args.tag} 且全部合格 {qualified} 词（排序键：{args.sort}）")
    print(f"  跳过：无 {args.tag} 标签 {skip['no_tag']} / 基础词({'/'.join(excl) or '未启用'}) {skip['basic']}"
          f" / 无音标 {skip['no_phonetic']} / 无释义 {skip['no_meaning']}"
          f" / 非法字符或专名 {skip['bad_chars']} / 词组 {skip['phrase']}")
    print(f"  实收：{qualified} − 单复数同源去重 {len(dropped_plural)} = {qualified - len(dropped_plural)} 词")
    if dropped_plural:
        preview = ", ".join(dropped_plural[:12])
        print(f"    去重明细（{len(dropped_plural)} 个冗余复数）：{preview}"
              f"{' ...' if len(dropped_plural) > 12 else ''}")
    print(f"按词频取前 {len(out)} 词 → {args.out}")
    if args.limit and len(out) < args.limit:
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
