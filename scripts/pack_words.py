#!/usr/bin/env python3
"""
pack_words.py —— 把词表打包成 seed_words 云函数的入参

为什么要打包：几千个词直接手搓 JSON 不现实，而控制台的「云端测试」入参框
也吃不下整份词表。本脚本按 --batch-size 切分成多个 JSON 文件，每个文件都是
一份**完整可用**的入参，依次粘进控制台执行即可。

用法：
  # 全量词表（默认 200 词一批）
  python scripts/pack_words.py

  # 小批（控制台入参框卡顿时）
  python scripts/pack_words.py --batch-size 100

  # 只导前 100 词做试点
  python scripts/pack_words.py --wordlist assets/word_lists/pilot-100.json

产出：
  build/seed_words/batch-01.json ...
  build/seed_words/index.json      批次清单（含每批词数、seq 区间，便于核对）

调用前请把 batch-*.json 里的 "__ADMIN_TOKEN__" 换成真实密钥：
  python scripts/fill_token.py --dir build/seed_words

关于 seq：词表里的 seq 会被去掉。seed_words 按**库中现有的最大 seq 续号**，
因此分批导入天然连续。⚠️ 想让 seq 从 1 开始，必须先在空库导入 —— 若库里
已有旧词表，请先跑 reset_words（mode:'purge' + confirm:'PURGE'）清空。
"""
import argparse
import json
import os

TOKEN_PLACEHOLDER = "__ADMIN_TOKEN__"

# 只保留 seed_words 会真正读取的字段（services 侧对未知字段直接忽略，传了也没用）
KEEP_FIELDS = ("word", "phoneticUK", "phoneticUS", "pos", "meaning", "level", "source")


def slim(item):
    """裁掉 seq 等由云端生成的字段，减小入参体积、避免误解。"""
    return {k: item[k] for k in KEEP_FIELDS if item.get(k) not in (None, "")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wordlist", default="assets/word_lists/ielts-full.json")
    ap.add_argument("--outdir", default="build/seed_words")
    ap.add_argument("--batch-size", type=int, default=200,
                    help="每批词数，默认 200（单批约 50KB）")
    args = ap.parse_args()

    if not os.path.isfile(args.wordlist):
        raise SystemExit(f"找不到 {args.wordlist}，请先跑 scripts/build_wordlist.py")

    with open(args.wordlist, "r", encoding="utf-8") as f:
        words = json.load(f)
    if not isinstance(words, list) or not words:
        raise SystemExit(f"{args.wordlist} 不是非空数组")

    # 去重（按 word）并校验必填字段
    seen, clean = set(), []
    for w in words:
        name = (w.get("word") or "").strip()
        if not name or name in seen:
            continue
        if not w.get("meaning"):
            print(f"⚠️ 缺少释义，跳过：{name}")
            continue
        seen.add(name)
        clean.append(slim(w))

    os.makedirs(args.outdir, exist_ok=True)
    size = max(1, args.batch_size)
    batches = [clean[i:i + size] for i in range(0, len(clean), size)]

    names, manifest = [], []
    for i, batch in enumerate(batches, 1):
        name = f"batch-{i:02d}.json"
        payload = {"_token": TOKEN_PLACEHOLDER, "words": batch}
        path = os.path.join(args.outdir, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        names.append(name)
        manifest.append({
            "file": name,
            "count": len(batch),
            "first": batch[0]["word"],
            "last": batch[-1]["word"],
            "bytes": os.path.getsize(path),
        })
        print(f"  {name}  {len(batch):>4} 词  {os.path.getsize(path) / 1024:>6.1f} KB"
              f"  {batch[0]['word']} … {batch[-1]['word']}")

    with open(os.path.join(args.outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"total": len(clean), "batches": manifest}, f,
                  ensure_ascii=False, indent=2)

    total_kb = sum(m["bytes"] for m in manifest) / 1024
    print(f"\n共 {len(batches)} 批，{len(clean)} 词，合计 {total_kb:.1f} KB")
    print(f"输出目录：{args.outdir}")
    print(f'\n调用前把每个 batch-*.json 里的 "{TOKEN_PLACEHOLDER}" 换成真实 ADMIN_TOKEN：')
    print(f"  python scripts/fill_token.py --dir {args.outdir}")


if __name__ == "__main__":
    main()
