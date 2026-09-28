#!/usr/bin/env python3
"""
pack_audio.py —— 把生成的 mp3 打包成 seed_audio 云函数的入参

为什么要分批：云函数入参有大小上限，音频以 base64 送入会有约 1/3 膨胀。
本脚本按「单批 base64 总量不超过 --max-bytes」切分，产出多个 JSON 文件，
每个文件可直接粘进控制台的「云端测试」执行，或用 CLI 调用。

用法：
  # 单词音频
  python scripts/pack_audio.py
  python scripts/pack_audio.py --max-bytes 300000

  # 例句音频（manifest 里带 text 字段，脚本自动识别并生成句子入参）
  python scripts/pack_audio.py --manifest build/sentence_audio/manifest.json \
      --audiodir build/sentence_audio --outdir build/seed_sentence --max-bytes 300000

产出：
  build/seed_audio/batch-01.json ...
  build/seed_audio/index.json     批次清单（含 word 列表，便于核对）

单条入参结构（按 manifest 条目自动判断）：
  单词：{ "word": "council", "type": 2, "base64": "..." }
  例句：{ "kind": "sentence", "text": "The council ...", "type": 2, "base64": "..." }

调用前请把 batch-*.json 里的 "__ADMIN_TOKEN__" 替换成真实的 ADMIN_TOKEN
（即 seed_audio / seed_words 云函数环境变量里配置的那个值）。
"""
import argparse
import base64
import json
import os

TOKEN_PLACEHOLDER = "__ADMIN_TOKEN__"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="build/audio/manifest.json")
    ap.add_argument("--outdir", default="build/seed_audio")
    ap.add_argument("--audiodir", default="build/audio")
    ap.add_argument("--max-bytes", type=int, default=350000,
                    help="单批 base64 总量上限，默认 350KB（安全余量）")
    args = ap.parse_args()

    if not os.path.isfile(args.manifest):
        raise SystemExit(f"找不到 {args.manifest}，请先跑 scripts/gen_audio.py")

    with open(args.manifest, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    if not manifest:
        raise SystemExit("manifest 为空")

    os.makedirs(args.outdir, exist_ok=True)

    batches, cur, cur_size = [], [], 0
    total_b64 = 0
    for m in manifest:
        path = os.path.join(args.audiodir, m["file"])
        if not os.path.isfile(path):
            print(f"⚠️ 缺文件，跳过：{path}")
            continue
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        # 例句音频：以整句文本为 audio_cache 的 key，故用 kind + text 标识；
        # 单词音频用 word。两者混装也能正确处理。
        if m.get("text"):
            item = {"kind": "sentence", "text": m["text"], "type": m["type"], "base64": b64}
        else:
            item = {"word": m["word"], "type": m["type"], "base64": b64}
        if cur and cur_size + len(b64) > args.max_bytes:
            batches.append(cur)
            cur, cur_size = [], 0
        cur.append(item)
        cur_size += len(b64)
        total_b64 += len(b64)
    if cur:
        batches.append(cur)

    names = []
    for i, batch in enumerate(batches, 1):
        name = f"batch-{i:02d}.json"
        payload = {"_token": TOKEN_PLACEHOLDER, "items": batch}
        with open(os.path.join(args.outdir, name), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        names.append(name)
        print(f"  {name}  {len(batch)} 条音频")

    # 统计：带 text 的算例句，其余算单词
    sentences = [m for m in manifest if m.get("text")]
    words = sorted({m["word"] for m in manifest if m.get("word") and not m.get("text")})

    with open(os.path.join(args.outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({
            "items": len(manifest),
            "words": len(words),
            "sentences": len(sentences),
            "batches": names,
            "wordList": words,
        }, f, ensure_ascii=False, indent=2)

    label = f"{len(sentences)} 条例句" if sentences else f"{len(words)} 个单词"
    print(f"\n共 {len(batches)} 批，{len(manifest)} 个音频文件，{label}，"
          f"base64 合计 {total_b64 / 1024 / 1024:.2f} MB")
    print(f"输出目录：{args.outdir}")
    print(f'\n调用前把每个 batch-*.json 里的 "{TOKEN_PLACEHOLDER}" 换成真实 ADMIN_TOKEN')


if __name__ == "__main__":
    main()
