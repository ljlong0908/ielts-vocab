#!/usr/bin/env python3
"""
gen_audio.py —— 用 Kokoro-82M 本地批量生成单词发音

为什么用 Kokoro：Kokoro-82M 采用 **Apache-2.0** 许可证，因此「它生成的音频」
可以自由商用、可闭源分发。对比：
  - XTTS v2 (Coqui) 权重非商用、F5-TTS 权重 CC-BY-NC  —— 不可用
  - edge-tts 是 Edge 朗读服务的非官方客户端            —— 灰色，同 dictvoice
  - macOS `say` / Windows SAPI 受系统 EULA 约束        —— 商用受限

默认只生成**美音**（--types us）。小程序端 config.TTS_LANG = en_US，对应 type=2，
音频先只做美音即可满足播放需求；后续需要英音再显式加 --types uk / us,uk。

用法：
  # 生成前 100 词的美音（默认）
  python scripts/gen_audio.py --wordlist assets/word_lists/pilot-100.json --limit 100

  # 增量：续着上次往后生成下一批（已存在的文件自动跳过）
  python scripts/gen_audio.py --wordlist assets/word_lists/ielts-5000.json --offset 100 --limit 100

  # 需要时再补英音
  python scripts/gen_audio.py --wordlist ... --types uk

输出：
  build/audio/us/{slug}.mp3    美音（type=2，对应 config.TTS_LANG=en_US）
  build/audio/uk/{slug}.mp3    英音（type=1，对应 en_GB）
  build/audio/manifest.json    索引，供 pack_audio.py 打包成 seed_audio 入参
  build/audio/failed.json      生成失败的词

type 编号与小程序端 audio.js 的 langToType() 一致：1=英音，2=美音。
"""
import argparse
import json
import os
import re
import sys
import time

SAMPLE_RATE = 24000

# kind → (Kokoro lang_code, 音色, 小程序端的 audio type)
VOICES = {
    "us": ("a", "af_heart", 2),   # 美音
    "uk": ("b", "bf_emma", 1),    # 英音
}


def slug(word):
    """云存储文件名用的安全 slug，与 audio_cache 云函数的 TEXT_RE 语义一致。"""
    s = re.sub(r"[^a-z0-9]+", "_", word.lower()).strip("_")
    return s or "x"


def trim_silence(audio, thresh_ratio=0.02, pad_ms=20):
    """裁掉首尾静音，让点击发音后立即出声。"""
    import numpy as np

    if audio is None or len(audio) == 0:
        return audio
    a = np.asarray(audio, dtype="float32")
    peak = float(np.max(np.abs(a))) or 1.0
    thresh = peak * thresh_ratio
    loud = np.where(np.abs(a) > thresh)[0]
    if len(loud) == 0:
        return a
    pad = int(SAMPLE_RATE * pad_ms / 1000)
    start = max(0, int(loud[0]) - pad)
    end = min(len(a), int(loud[-1]) + pad)
    return a[start:end]


def encode_mp3(audio, sr=SAMPLE_RATE, bitrate=48):
    """优先 lameenc（纯 wheel，无需 ffmpeg）；失败则降级 soundfile 写 mp3。"""
    import numpy as np

    a = np.clip(np.asarray(audio, dtype="float32"), -1.0, 1.0)
    pcm = (a * 32767.0).astype("<i2")
    try:
        import lameenc

        enc = lameenc.Encoder()
        enc.set_bit_rate(bitrate)
        enc.set_in_sample_rate(sr)
        enc.set_channels(1)
        enc.set_quality(2)
        return enc.encode(pcm.tobytes()) + enc.flush()
    except ImportError:
        pass
    try:
        import io

        import soundfile as sf

        buf = io.BytesIO()
        sf.write(buf, a, sr, format="MP3")
        return buf.getvalue()
    except Exception as e:
        raise RuntimeError(f"没有可用的 mp3 编码器（pip install lameenc）: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wordlist", required=True, help="build_wordlist.py 产出的 JSON")
    ap.add_argument("--outdir", default="build/audio")
    ap.add_argument("--offset", type=int, default=0, help="从第几个词开始（增量生成用）")
    ap.add_argument("--limit", type=int, default=100, help="本次生成多少个词")
    ap.add_argument("--types", default="us", help="us / uk / us,uk（默认只做美音）")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    with open(args.wordlist, "r", encoding="utf-8") as f:
        all_words = json.load(f)
    batch = all_words[args.offset: args.offset + args.limit]
    if not batch:
        sys.exit(f"词表区间为空（共 {len(all_words)} 词，offset={args.offset}）")

    kinds = [k.strip() for k in args.types.split(",") if k.strip() in VOICES]
    if not kinds:
        sys.exit("--types 只能是 us / uk 的组合")

    try:
        from kokoro import KPipeline
    except ImportError:
        sys.exit("缺少依赖：pip install kokoro soundfile lameenc numpy")

    print(f"词表 {len(all_words)} 词，本次处理 [{args.offset}, {args.offset + len(batch)}) 共 {len(batch)} 词")
    print(f"音色：{', '.join(f'{k}={VOICES[k][1]}' for k in kinds)}")

    manifest, failed = [], []
    for kind in kinds:
        lang_code, voice, atype = VOICES[kind]
        outdir = os.path.join(args.outdir, kind)
        os.makedirs(outdir, exist_ok=True)
        print(f"\n=== {kind}（type={atype}, voice={voice}, lang_code={lang_code}）===")

        pipe = KPipeline(lang_code=lang_code)   # 模型只加载一次
        done = skip = 0
        t0 = time.time()

        for w in batch:
            word = w["word"]
            path = os.path.join(outdir, f"{slug(word)}.mp3")
            rel = os.path.relpath(path, args.outdir)

            if os.path.exists(path) and os.path.getsize(path) > 0:
                skip += 1
                manifest.append({
                    "word": word, "type": atype, "kind": kind,
                    "file": rel, "bytes": os.path.getsize(path),
                })
                continue

            try:
                audio = None
                for _, _, seg in pipe(word, voice=voice, speed=args.speed):
                    audio = seg if audio is None else __import__("numpy").concatenate([audio, seg])
                if audio is None or len(audio) == 0:
                    raise RuntimeError("空音频")
                audio = trim_silence(audio)
                data = encode_mp3(audio)
                with open(path, "wb") as f:
                    f.write(data)
                manifest.append({
                    "word": word, "type": atype, "kind": kind, "file": rel,
                    "bytes": len(data), "seconds": round(len(audio) / SAMPLE_RATE, 2),
                })
                done += 1
            except Exception as e:
                failed.append({"word": word, "kind": kind, "error": str(e)[:200]})

            n = done + skip
            if n % 20 == 0 or n == len(batch):
                el = time.time() - t0
                print(f"  {n}/{len(batch)}  新生成 {done}  跳过 {skip}  失败 {len(failed)}  "
                      f"({el:.0f}s, {n / el if el else 0:.1f} 词/秒)")

        print(f"  完成：新生成 {done}，已存在跳过 {skip}")

    os.makedirs(args.outdir, exist_ok=True)
    mpath = os.path.join(args.outdir, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    if failed:
        with open(os.path.join(args.outdir, "failed.json"), "w", encoding="utf-8") as f:
            json.dump(failed, f, ensure_ascii=False, indent=2)

    total = sum(m["bytes"] for m in manifest)
    print(f"\n清单 {len(manifest)} 条 → {mpath}（{total / 1024 / 1024:.1f} MB）")
    if failed:
        print(f"⚠️ 失败 {len(failed)} 条 → build/audio/failed.json")
    print("下一步：python scripts/pack_audio.py  打包成 seed_audio 的入参")


if __name__ == "__main__":
    main()
