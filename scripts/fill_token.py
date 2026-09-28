#!/usr/bin/env python3
"""
fill_token.py —— 把打包好的 batch-*.json 里的 __ADMIN_TOKEN__ 占位符换成真实密钥

为什么需要：音频（尤其例句，约 21KB/条）会切成多个 batch-*.json，
逐个手工替换密钥既繁琐又容易漏掉一两个。

密钥来源（按优先级）：
  1) 命令行 --token
  2) 环境变量 ADMIN_TOKEN
  3) 项目根 .env 里的 ADMIN_TOKEN（.env 已在 .gitignore 中）

用法：
  python scripts/fill_token.py --dir build/seed_sentence
  python scripts/fill_token.py --dir build/seed_audio
  python scripts/fill_token.py --dir build/seed_sentence --token xxxx --dry-run

⚠️ 替换后的文件内嵌明文密钥，位于 build/（已 gitignore）。
   用完请勿提交、勿移到项目其他位置。
"""
import argparse
import glob
import os
import sys

PLACEHOLDER = '"__ADMIN_TOKEN__"'


def load_env_file(path=".env"):
    """极简 .env 读取；已存在的环境变量优先，绝不覆盖。"""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="batch-*.json 所在目录")
    ap.add_argument("--token", default="", help="直接指定密钥（不传则读环境变量 / .env）")
    ap.add_argument("--dry-run", action="store_true", help="只报告会改几个文件，不写入")
    args = ap.parse_args()

    token = args.token.strip()
    if not token:
        load_env_file()
        token = os.environ.get("ADMIN_TOKEN", "").strip()
    if not token:
        sys.exit("缺少 ADMIN_TOKEN。三种方式：--token xxx / export ADMIN_TOKEN=xxx / 写进项目根 .env")

    files = sorted(glob.glob(os.path.join(args.dir, "batch-*.json")))
    if not files:
        sys.exit(f"{args.dir} 下没有 batch-*.json")

    changed = skipped = 0
    for p in files:
        with open(p, "r", encoding="utf-8") as f:
            text = f.read()
        if PLACEHOLDER not in text:
            print(f"  - {os.path.basename(p)}  已是真实密钥，跳过")
            skipped += 1
            continue
        new = text.replace(PLACEHOLDER, '"%s"' % token)
        if not args.dry_run:
            with open(p, "w", encoding="utf-8") as f:
                f.write(new)
        changed += 1
        print(f"  ✓ {os.path.basename(p)}  已填入密钥")

    print(f"\n{'（dry-run，未写入）' if args.dry_run else '完成'}："
          f"改动 {changed} 个，跳过 {skipped} 个，共 {len(files)} 个文件")
    print("⚠️ 这些文件现在含明文密钥（build/ 已 gitignore），勿提交、勿外移。")


if __name__ == "__main__":
    main()
