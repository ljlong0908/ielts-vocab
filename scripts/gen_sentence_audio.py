#!/usr/bin/env python3
"""
gen_sentence_audio.py —— 用 Kokoro-82M 本地批量合成**例句**语音

与 gen_audio.py（单词发音）的两点不同：
  1. 输入不是词表，而是 gen_examples.py 产出的例句 JSON（example.en）
  2. **文件名改用 hash，不能用 slug**
     例句长达数十字符且含逗号/句号，转 slug 会得到超长（甚至因标点全被替换为空）
     且容易碰撞的文件名。这里统一用 `s_{hash}`，hash 算法与
     cloudfunctions/seed_audio 的 hashText() 严格一致。

为什么要走本地合成：
  例句语音若走第三方（dictvoice 整句直接返回 null），无法实现；若走云端 TTS 则
  每次播放都要外呼。本地预生成后上传云存储，运行时只查索引，零外呼。

用法：
  # 先有例句（gen_examples.py 产出）
  python scripts/gen_sentence_audio.py --examples assets/examples/pilot-100-examples.json

  # 先试听几条
  python scripts/gen_sentence_audio.py --examples ... --limit 5

输出：
  build/sentence_audio/us/s_{hash}.mp3   美音（type=2）
  build/sentence_audio/manifest.json     索引，供 pack_audio.py 打包
  build/sentence_audio/failed.json       失败清单
"""
import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_audio import SAMPLE_RATE, VOICES, encode_mp3, trim_silence  # noqa: E402
from text_key import hash_text  # noqa: E402


def sentence_slug(text):
    """句子音频的云存储文件名（不含扩展名）。s_ 前缀与单词音频区分。"""
    return "s_" + hash_text(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--examples", required=True, help="gen_examples.py 产出的 JSON")
    ap.add_argument("--outdir", default="build/sentence_audio")
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0, help="0 表示全部")
    ap.add_argument("--types", default="us", help="us / uk / us,uk（默认只做美音）")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    if not os.path.isfile(args.examples):
        sys.exit(f"找不到例句文件：{args.examples}（先跑 scripts/gen_examples.py）")

    with open(args.examples, "r", encoding="utf-8") as f:
        rows = json.load(f)

    batch = rows[args.offset: args.offset + args.limit] if args.limit > 0 else rows[args.offset:]
    if not batch:
        sys.exit("例句区间为空")

    kinds = [k.strip() for k in args.types.split(",") if k.strip() in VOICES]
    if not kinds:
        sys.exit("--types 只能是 us / uk 的组合")

    try:
        from kokoro import KPipeline
    except ImportError:
        sys.exit("缺少依赖：pip install kokoro soundfile lameenc numpy")

    # hash 撞车自检：不同文本算出同一 hash 会导致音频互相覆盖
    seen = {}
    for r in rows:
        en = (r.get("example") or {}).get("en") or ""
        if not en:
            continue
        s = sentence_slug(en)
        if s in seen and seen[s] != en:
            print(f"⚠️ hash 撞车：{seen[s][:40]}... 与 {en[:40]}... 同 slug {s}")
        seen[s] = en

    print(f"例句 {len(rows)} 条，本次处理 [{args.offset}, {args.offset + len(batch)}) 共 {len(batch)} 条")
    print(f"音色：{', '.join(f'{k}={VOICES[k][1]}' for k in kinds)}")

    manifest, failed = [], []
    for kind in kinds:
        lang_code, voice, atype = VOICES[kind]
        outdir = os.path.join(args.outdir, kind)
        os.makedirs(outdir, exist_ok=True)
        print(f"\n=== {kind}（type={atype}, voice={voice}）===")

        pipe = KPipeline(lang_code=lang_code)
        done = skip = 0
        t0 = time.time()

        for r in batch:
            word = r.get("word") or ""
            text = ((r.get("example") or {}).get("en") or "").strip()
            if not text:
                failed.append({"word": word, "kind": kind, "error": "NO_EXAMPLE"})
                continue

            name = f"{sentence_slug(text)}.mp3"
            path = os.path.join(outdir, name)
            rel = os.path.relpath(path, args.outdir)

            if os.path.exists(path) and os.path.getsize(path) > 0:
                skip += 1
                manifest.append({
                    "word": word, "text": text, "type": atype,
                    "file": rel, "bytes": os.path.getsize(path),
                })
                continue

            try:
                import numpy as np

                audio = None
                for _, _, seg in pipe(text, voice=voice, speed=args.speed):
                    audio = seg if audio is None else np.concatenate([audio, seg])
                if audio is None or len(audio) == 0:
                    raise RuntimeError("空音频")

                audio = trim_silence(audio)
                data = encode_mp3(audio)
                with open(path, "wb") as f:
                    f.write(data)

                manifest.append({
                    "word": word, "text": text, "type": atype, "file": rel,
                    "bytes": len(data), "seconds": round(len(audio) / SAMPLE_RATE, 2),
                })
                done += 1
            except Exception as e:
                failed.append({"word": word, "kind": kind, "error": str(e)[:200]})

            n = done + skip
            if n % 10 == 0 or n == len(batch):
                el = time.time() - t0
                print(f"  {n}/{len(batch)}  新生成 {done}  跳过 {skip}  失败 {len(failed)}  "
                      f"({el:.0f}s, {n / el if el else 0:.1f} 条/秒)")

        print(f"  完成：新生成 {done}，已存在跳过 {skip}")

    os.makedirs(args.outdir, exist_ok=True)
    mpath = os.path.join(args.outdir, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    if failed:
        with open(os.path.join(args.outdir, "failed.json"), "w", encoding="utf-8") as f:
            json.dump(failed, f, ensure_ascii=False, indent=2)

    total = sum(m["bytes"] for m in manifest)
    avg = total / len(manifest) if manifest else 0
    print(f"\n清单 {len(manifest)} 条 → {mpath}")
    print(f"合计 {total / 1024:.1f} KB，平均 {avg / 1024:.1f} KB/条")
    if failed:
        print(f"⚠️ 失败 {len(failed)} 条 → build/sentence_audio/failed.json")
    print("下一步：python scripts/pack_audio.py --manifest build/sentence_audio/manifest.json "
          "--audiodir build/sentence_audio --outdir build/seed_sentence")


if __name__ == "__main__":
    main()
