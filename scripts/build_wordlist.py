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

清洗（顺序执行，规则都在下方常量里，重跑即复现）：
  1. 基础词       —— 带 zk/gk 标签的中考/高考词不入表（--exclude-tags 控制）
  2. 名词复数归一 —— 纯复数条目一律不作为词条，按原形处置（KEEP_PLURAL 为例外）：
                      · 原形已在表内  → 丢弃（冗余复数）
                      · 原形是基础词  → 丢弃（不因复数把 wheel / job / light 拖回表）
                      · 原形查得到    → 提升为原形（utensils → utensil）
  3. 专名         —— 地名/机构/姓氏剔除（判据见 PROPER_NOUNS 上方说明）
  判据取自 ECDICT 自身字段，不比拼字符串，详见 pure_plural_lemma() 的说明。

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

# 形似复数、实为**独立词条**的词：单复数必须都保留，不参与「名词复数归一」。
# 不在这个名单里的纯复数条目会被丢弃或提升为原形（见 pure_plural_lemma）——
# 复数拼写可由单数推导，对雅思学习没有增量价值，却会挤占学习队列、让列表显得臃肿。
# ⚠️ 新增例外前先确认：该复数的语义/用法是否真的无法由单数推得。
KEEP_PLURAL = {
    # 学科名词（-ics 结尾，本身即单数）
    "economics", "statistics", "ethics", "politics", "physics", "mathematics",
    "linguistics", "psycholinguistics",
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
    "bacteria",    # 通常按集合名词整体使用（同 data）；原形 bacterium 是罕见技术词
    # 单复数同形，避免被归一规则误删
    "news", "series", "species",
}


# ---------------------------------------------------------------------------
# 名词复数归一（word-family normalization）
#
# 为什么必须做：ECDICT 的词形标记不完整——`ielts` 标签打在**复数**上、原形反而被
# 当基础词排除的情况很多。结果是词表尾部堆了一整簇「只有复数、没有单数」的条目
# （wheels / visas / utensils / universities …），对学习者毫无意义：该先学 wheel、
# utensil，而不是把复数形式当成一个独立词汇去背。
#
# 判据直接取 ECDICT 的 `exchange` 字段，不做字符串猜测：
#   · exchange 的 `0:` 键是**原形**，指向别的词即说明本条目是变形词
#   · `1:` 键是变形类型（s=复数 / 3=三单 / d=过去分词 / i=现在分词 / r=比较级 / t=最高级 …）
# 两个条件缺一不可：
#   1. `0:` 指向别的词 —— `0:` 指向自身的（outskirts / tweezers / stairs / surroundings）
#      是英语里天然只有复数形的名词，ECDICT 以自身为原形，必须放行。
#   2. 变形标记只有 s / 3 —— 排除同样带 `0:` 但属于独立词条的词：
#      best(0:good,t) / further(0:far,r) / advanced(0:advance,dp) / banking(0:bank,i) /
#      sophisticated(0:sophisticate,dp) / regarding(0:regard,i) / provided(0:provide,dp)。
#      早期用「以 s 结尾 + 去 s 的单数存在」这种字符串规则，既漏（wheels 抓到了但
#      漏掉 tours）又误（ambitious / crisis / series / campus / debris 全被误判）；
#      若粗暴地「一切变形词都丢」，则会连带杀掉 161 个合法词条（见到上方那串即可知）。
# ---------------------------------------------------------------------------
PLURAL_MARKS = frozenset("s3")      # exchange 中代表「复数 / 三单」的变形标记


def parse_exchange(ex: str):
    """解析 ECDICT 的 exchange 字段 → (原形, 变形标记集合)。

    形如 `p:toured/d:toured/i:touring/3:tours`；键 `0` 特殊，值是原形。
    """
    lemma, marks = None, set()
    for seg in (ex or "").split("/"):
        if ":" not in seg:
            continue
        key, val = seg.split(":", 1)
        key, val = key.strip(), val.strip().lower()
        if key == "0":
            lemma = val or None
        else:
            marks.update(ch for ch in val if ch.isalnum())
    return lemma, marks


def pure_plural_lemma(word: str, exchange: str):
    """该词若是「纯名词复数变形」，返回其单数原形；否则返回 None。"""
    lemma, marks = parse_exchange(exchange)
    if not lemma or lemma == word:
        return None
    if not marks or not marks <= PLURAL_MARKS:
        return None
    return lemma


# ---------------------------------------------------------------------------
# 专名（地名 / 机构名 / 姓氏）剔除
#
# 为什么必须剔：ECDICT 的 ielts 标签里混入了不少专名（雅思阅读听力里出现过，
# 就被打了标签）。它们朗读没问题，但作为「词汇」毫无学习价值，还会挤占学习队列
# ——york 曾被词频排到第 48 位（因为 New York 语料频次极高），等于让用户很早就
# 学到一个人名/地名。
#
# 判据取自 ECDICT 自身的两个字段（在合格候选池上命中 5 个、**0 误报**）：
#   A. 中文释义的括号注释是「地名/姓氏/王朝」类标记
#      → 悉尼（澳大利亚港市）、福布斯（美国出版及媒体集团）、图尔斯（姓氏）
#   B. 英文释义是地名 / 王室的「指认句式」
#      → the largest Australian city located in …、the English royal house … reigned from
# 两条都刻意收紧过：早期宽松写法（任何含 city/town/state 的释义）命中 106 个，
# 绝大多数是 "the state of being …" 这类正常释义，不可用。
#
# 误杀逃生舱：万一将来 ECDICT 更新后某个正经词被规则命中，把它加进这里即可放行，
# 无需改判据。词表重建时会打印被剔除的全部专名，便于复核。
# ---------------------------------------------------------------------------
PROPER_NOUNS = {
    "york",         # 约克郡 / 约克王朝（seq 48 —— 词频被 New York 抬高）
    "sydney",       # 悉尼（澳大利亚港市）
    "forbes",       # 福布斯（媒体集团 / 姓氏）
    "tours",        # 图尔斯（姓氏）；图尔市（法国城市名）
    "wollongong",   # 伍伦贡（澳大利亚东南部港市）
}

KEEP_PROPER_LOOKING = set()   # 逃生舱：命中判据但确认是普通词的，写在这里

# A. 中文释义括号注释里的专名标记
_BRACKET = re.compile(r"[（(\[]([^）)\]]{1,14})[）)\]]")
_NAME_MARK = re.compile(r"(地名|姓氏|王朝|人名|港市|城市|国名|首都|州郡)$"
                        r"|^(澳大利亚|英国|美国|法国|加拿大|新西兰)")

# B. 英文释义里的地名 / 王室指认句式
_PLACE_SENTENCE = re.compile(
    r"\b(?:a|an|the)\s+(?:city|town|village|port|borough|county|province"
    r"|island|river|lake|capital|republic|kingdom|empire)\s+(?:in|on|of|near|that)\b"
    r"|\bcapital of\b|\broyal house\b",
    re.I,
)


def is_proper_noun(translation: str, definition: str) -> bool:
    """该词是否是地名 / 机构名 / 姓氏这类「不值得学的专名」。"""
    tr = (translation or "").replace("\\n", "；")
    for mark in _BRACKET.findall(tr):
        if _NAME_MARK.search(mark):
            return True
    return bool(_PLACE_SENTENCE.search(definition or ""))


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
            "bad_chars": 0, "phrase": 0, "proper": 0}
    dropped_proper = []

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
            # 专名剔除（判据见 PROPER_NOUNS 上方说明；显式清单作为判据的兜底）
            if word.lower() not in KEEP_PROPER_LOOKING and (
                    word.lower() in PROPER_NOUNS
                    or is_proper_noun(r.get("translation"), r.get("definition"))):
                skip["proper"] += 1
                dropped_proper.append(word.lower())
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
                "_exchange": r.get("exchange") or "",   # 供后续复数归一使用，输出前丢弃
            })

    # --- 名词复数归一（见 KEEP_PLURAL / pure_plural_lemma 的说明）----------------
    qualified = len(rows)
    vocabulary = {r["word"] for r in rows}

    plural_of = {}
    for r in rows:
        lemma = pure_plural_lemma(r["word"], r.pop("_exchange", ""))
        if lemma:
            plural_of[r["word"]] = lemma

    # 原形不在候选池内的，需要它的音标/释义/标签 → 再扫一遍源文件取原形行
    needs = {lem for lem in plural_of.values() if lem not in vocabulary}
    lemma_meta = {}
    if needs:
        with open(args.src, "r", encoding="utf-8", errors="replace", newline="") as f:
            for r in csv.DictReader(f):
                key = (r.get("word") or "").strip().lower()
                if key in needs and key not in lemma_meta:
                    lemma_meta[key] = r

    dropped_plural, promoted, used_lemma = [], {}, set()
    for r in rows:
        word = r["word"]
        lemma = plural_of.get(word)
        if not lemma or word in KEEP_PLURAL:
            continue
        meta = lemma_meta.get(lemma)
        # 不具备「提升为原形」条件的一律丢弃：
        #   原形已在表内（冗余复数）/ 原形是基础词（不该因复数把 wheel 拖回表）
        #   / 原形查不到 / 已在本次提升中用掉 / 原形没有音标或释义
        if (lemma in vocabulary or meta is None or lemma in used_lemma
                or (excl and set((meta.get("tag") or "").lower().split()) & set(excl))
                or not norm_phonetic(meta.get("phonetic"))
                or not norm_meaning(meta.get("translation"))):
            dropped_plural.append(word)
            continue
        used_lemma.add(lemma)
        promoted[word] = lemma

    if dropped_plural:
        dropped_set = set(dropped_plural)
        rows = [r for r in rows if r["word"] not in dropped_set]
    for r in rows:                        # 提升：改用原形自己的字段与词频参与排序
        lemma = promoted.get(r["word"])
        if not lemma:
            continue
        meta = lemma_meta[lemma]
        r["word"] = lemma
        r["phoneticUK"] = r["phoneticUS"] = norm_phonetic(meta.get("phonetic"))
        r["pos"] = norm_pos(meta.get("pos"))
        r["meaning"] = norm_meaning(meta.get("translation"))
        r["_freq"] = freq_key(meta, sort_order)      # 按原形词频落位，而非沿用复数的词位
        r["source"] = f"ecdict-{args.tag}-lemma"     # 便于区分「由复数提升」的词条

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
        r.pop("_exchange", None)
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
          f" / 首字母大写或非法字符 {skip['bad_chars']} / 词组 {skip['phrase']}"
          f" / 专名 {skip['proper']}")
    if dropped_proper:
        print(f"    剔除的专名（{len(dropped_proper)} 个）：{', '.join(sorted(dropped_proper))}")
    stale = sorted(PROPER_NOUNS - set(dropped_proper))
    if stale:
        print(f"    ⚠️ PROPER_NOUNS 中未命中判据的条目（请复核）：{', '.join(stale)}")
    print(f"  实收：{qualified} − 复数归一丢弃 {len(dropped_plural)} = {qualified - len(dropped_plural)} 词")
    if promoted:
        preview = ", ".join(f"{p}→{l}" for p, l in sorted(promoted.items())[:10])
        print(f"    复数提升为原形（{len(promoted)} 个）：{preview}"
              f"{' ...' if len(promoted) > 10 else ''}")
    if dropped_plural:
        preview = ", ".join(sorted(dropped_plural)[:14])
        print(f"    丢弃的纯复数（{len(dropped_plural)} 个）：{preview}"
              f"{' ...' if len(dropped_plural) > 14 else ''}")
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
