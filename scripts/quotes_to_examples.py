#!/usr/bin/env python3
"""
quotes_to_examples.py —— 把「每日一句」语料转成 gen_sentence_audio.py 能吃的输入

为什么需要这一步：
  每日一句（M12）的文案放在 miniprogram/utils/quotes.js —— 纯前端静态语料，
  按日取模轮换。但它**没有音频**：首页喇叭走的是例句音频链路
  （audio.js playSentence → audio_cache kind='sentence'），而例句音频的生成
  入口 gen_sentence_audio.py 只认 gen_examples.py 的产出格式
  （一行一个词，取 r["example"]["en"]）。

  与其手工维护第二份句子清单（会与 quotes.js 漂移），不如每次从 quotes.js
  现抽现转 —— quotes.js 恒为唯一数据源。

用法：
  python scripts/quotes_to_examples.py
  # → assets/examples/quotes-12.json

之后：
  python scripts/gen_sentence_audio.py --examples assets/examples/quotes-12.json \
      --outdir build/quote_audio --types us
  python scripts/seed_quote_audio.py
"""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUOTES_JS = os.path.join(ROOT, "miniprogram", "utils", "quotes.js")
OUT_FILE = os.path.join(ROOT, "assets", "examples", "quotes-12.json")

# quotes.js 里每条是 { text: '...', cn: '...', author: '...', tags: [...] }
# 字符串字面量统一用单引号，且内容中不含单引号（已核对），故这里不做转义处理。
FIELD_RE = re.compile(r"^\s*(text|cn|author):\s*'([^']*)'\s*,?\s*$", re.M)


def parse_quotes(path):
    """从 quotes.js 抽出 [{text, cn, author}]，保持文件中的先后顺序。"""
    if not os.path.isfile(path):
        sys.exit(f"找不到 {os.path.relpath(path, ROOT)}")

    with open(path, encoding="utf-8") as f:
        src = f.read()

    # 只取 LINES 数组那一段：module.exports 之后的 today() 里没有这些字段，
    # 但为稳妥起见还是切到数组结束，避免将来在别处出现同名字段被误收。
    m = re.search(r"const LINES\s*=\s*\[(.*?)\n\]", src, re.S)
    if not m:
        sys.exit("在 quotes.js 里没定位到 `const LINES = [...]`（格式变了？）")
    body = m.group(1)

    # 按 text 切段：每条语料都以 text 开头
    chunks = re.split(r"\n\s*\{\s*\n(?=\s*text:)", body)
    rows = []
    for ch in chunks:
        if not ch.strip():
            continue
        fields = dict(FIELD_RE.findall(ch))
        if not fields.get("text"):
            continue
        rows.append({
            "text": fields["text"].strip(),
            "cn": fields.get("cn", "").strip(),
            "author": fields.get("author", "").strip(),
        })

    if not rows:
        sys.exit("一条都没抽到 —— quotes.js 的写法可能变了，请检查 FIELD_RE")
    return rows


def main():
    rows = parse_quotes(QUOTES_JS)

    # 自检：必须与 quotes.js 里的 text 字段数一致，防止正则漏收
    with open(QUOTES_JS, encoding="utf-8") as f:
        decl_count = len(re.findall(r"^\s*text:\s*'", f.read(), re.M))
    if decl_count != len(rows):
        sys.exit(f"抽到 {len(rows)} 条，但 quotes.js 里声明了 {decl_count} 条 text —— 解析漏了")

    # 转成 gen_sentence_audio.py 的入参形状：
    #   它只读 r["word"]（仅作日志/清单标识）与 r["example"]["en"]（真正要合成的句子）
    out = [
        {
            "word": f"quote-{i:02d}",
            "example": {"en": r["text"], "cn": r["cn"]},
            "author": r["author"],
        }
        for i, r in enumerate(rows, 1)
    ]

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"✓ {len(out)} 句 → {os.path.relpath(OUT_FILE, ROOT)}")
    for o in out[:3]:
        print(f"    {o['word']}  {o['example']['en'][:56]}")
    if len(out) > 3:
        print(f"    …（共 {len(out)} 句）")


if __name__ == "__main__":
    main()
