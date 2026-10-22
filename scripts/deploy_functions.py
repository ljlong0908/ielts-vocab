#!/usr/bin/env python3
"""
deploy_functions.py —— 一条命令部署云函数（免去在开发者工具里逐个手点）

为什么需要它：
  微信开发者工具**没有**「保存即自动部署」这种钩子，云函数必须显式上传。
  但工具自带 CLI 支持批量部署 —— 18 个函数可以一条命令搞定，
  甚至只传「改过的」那几个。

前提（只需做一次）：
  开发者工具 → 设置 → 安全设置 → 打开「服务端口」。
  ⚠️ 没开的话 CLI 会**静默卡住不返回**（不是报错），本脚本会超时并提示。

用法：
  python3 scripts/deploy_functions.py                # 只部署改动过的（默认）
  python3 scripts/deploy_functions.py --all          # 全部 18 个
  python3 scripts/deploy_functions.py --names stats dismiss_wrong
  python3 scripts/deploy_functions.py --dry-run      # 只打印要传哪些，不执行
  python3 scripts/deploy_functions.py --local-deps   # 连本地 node_modules 一起传（慢）

「改动过」怎么判定（三者并集，宁多勿漏）：
  ① git 未提交的改动 / 未跟踪的新目录
  ② mtime 比 build/.deploy-state.json 里记录的「上次部署时间」新
  ③ 从没部署过（state 里没有记录）

传参用 `-r`（--remote-npm-install，等价于界面上的「云端安装依赖」）：
  本地 node_modules **不会**上传。本项目 4 个函数各带 80MB node_modules
  （共 322MB，是此前为绕开 -504002 手工拷的），加 -r 后体积回到几十 KB，
  且依赖由云端按 package.json 安装 —— 这才是正确姿势。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import warnings

# wxcloud 会 import requests → 在 macOS 系统 Python 上会抛 LibreSSL 告警，纯噪音
warnings.filterwarnings("ignore")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wxcloud import ROOT, log, require_config  # noqa: E402

CLI = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
CF_DIR = os.path.join(ROOT, "cloudfunctions")
STATE_FILE = os.path.join(ROOT, "build", ".deploy-state.json")


# ---------------------------------------------------------------- 函数发现

def all_functions():
    """返回 cloudfunctions/ 下所有函数名（排除 node_modules 等非函数目录）。"""
    out = []
    for name in sorted(os.listdir(CF_DIR)):
        d = os.path.join(CF_DIR, name)
        if not os.path.isdir(d) or name.startswith(".") or name == "node_modules":
            continue
        # 一个合法的云函数至少得有 index.js
        if os.path.isfile(os.path.join(d, "index.js")):
            out.append(name)
    return out


def _git_changed():
    """git 未提交改动 + 未跟踪的新目录 → 函数名集合。"""
    try:
        r = subprocess.run(
            ["git", "status", "--porcelain", "--", "cloudfunctions"],
            cwd=ROOT, capture_output=True, text=True, timeout=20,
        )
    except Exception:  # noqa: BLE001
        return set()
    if r.returncode != 0:
        return set()
    changed = set()
    for line in r.stdout.splitlines():
        if len(line) < 4:
            continue
        path = line[3:].strip().strip('"')
        # cloudfunctions/<name>/...
        parts = path.split("/")
        if len(parts) >= 2 and parts[0] == "cloudfunctions":
            changed.add(parts[1])
    return changed & set(all_functions())


def _mtime_changed():
    """比「上次部署时间」新、或从没部署过 → 函数名集合。

    ⚠️ 基线（state 文件）不存在时**直接返回空集**：此时无法区分「没部署过」和
    「已部署但没记录」，一律算作改动会让首次运行退化成「全部 18 个」，
    与「只传改过的」的直觉不符。首次运行就只认 git 改动，随后建立基线。
    """
    if not os.path.isfile(STATE_FILE):
        return set()
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            state = json.load(f)
    except Exception:  # noqa: BLE001
        return set()
    out = set()
    for name in all_functions():
        d = os.path.join(CF_DIR, name)
        newest = 0.0
        for base, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if x != "node_modules"]  # 依赖不算源码改动
            for fn in files:
                if fn.endswith((".log", ".DS_Store")):
                    continue
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(base, fn)))
                except OSError:
                    pass
        last = state.get(name)
        if last is None:
            out.add(name)                      # 从没部署过
        elif newest > float(last) + 1:         # 比上次部署新（1s 容差）
            out.add(name)
    return out


def changed_functions():
    return _git_changed() | _mtime_changed()


def record_deployed(names):
    """把本次部署成功的函数写入 state（供下次增量判定）。"""
    state = {}
    if os.path.isfile(STATE_FILE):
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                state = json.load(f)
        except Exception:  # noqa: BLE001
            state = {}
    now = time.time()
    for n in names:
        state[n] = now
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, sort_keys=True)


# ---------------------------------------------------------------- 部署

def deploy(names, env, *, remote_install=True, timeout=600):
    """调 IDE CLI 批量部署。返回 (失败的函数集合, 输出文本)。"""
    cmd = [CLI, "cloud", "functions", "deploy",
           "--env", env,
           "--project", ROOT]
    if remote_install:
        cmd.append("-r")
    # --names 放最后：它是 array 类型，会吞掉紧随其后的位置参数
    cmd += ["--names"] + names

    log("$ " + " ".join(cmd))
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, (
            "TIMEOUT：CLI 超时未返回。\n"
            "  最常见原因＝开发者工具没开「服务端口」。\n"
            "  请：开发者工具 → 设置 → 安全设置 → 打开「服务端口」，然后重试。"
        )
    except FileNotFoundError:
        return None, f"找不到 CLI：{CLI}\n（微信开发者工具没装在这个路径？）"

    out = (r.stdout or "") + (r.stderr or "")

    # ⚠️ CLI 进程退出码不可信：实测批量里 8 个全失败仍 exit 0。
    #    以输出里的失败迹象为准，宁多勿漏：
    #    ① per-function 结果行：✖ [fn]（带括号）或 ✖ fn（无括号也收）
    #    ② 结尾 success 表格里的 false
    #    ③ 整体失败：服务端口关闭（"IDE service port disabled" / "服务端口已关闭"）、
    #       ✖ initialize 这类不带函数名的 ✖ 行 —— 命中即本次一个都没传成功，
    #       全部计入 failed（绝不写 state，否则下次增量部署会静默跳过它）
    failed = set(re.findall(r"✖ \[(\w[\w-]*)\]", out))
    for m in re.finditer(r"\|\s+(\w[\w-]*)\s+\|\s+false\s+\|", out):
        failed.add(m.group(1))
    global_fail = bool(
        re.search(r"✖(?!\s*\[)", out)
        or "service port disabled" in out.lower()
        or "服务端口已关闭" in out
    )
    if global_fail:
        failed |= set(names)
    return failed, out


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="一条命令部署微信云函数")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--all", action="store_true", help="部署全部函数")
    g.add_argument("--changed", action="store_true", help="只部署改动过的（默认）")
    g.add_argument("--names", nargs="+", metavar="FN", help="只部署指定的函数")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不真正部署")
    ap.add_argument("--local-deps", action="store_true",
                    help="连本地 node_modules 一起传（不用云端安装依赖；很慢）")
    ap.add_argument("--timeout", type=int, default=600, help="CLI 超时秒数（默认 600）")
    args = ap.parse_args()

    appid, _secret, env = require_config()
    if not env:
        log("✗ 没找到 ENV_ID（应写在 miniprogram/config.js 里，或设环境变量 ENV_ID）")
        return 2

    every = all_functions()

    if args.names:
        unknown = [n for n in args.names if n not in every]
        if unknown:
            log(f"✗ 这些不是云函数目录：{', '.join(unknown)}")
            log(f"  可用：{', '.join(every)}")
            return 2
        target = [n for n in every if n in set(args.names)]  # 保持稳定顺序
        why = "指定"
    elif args.all:
        target, why = every, "全部"
    else:
        ch = changed_functions()
        target = [n for n in every if n in ch]
        why = "改动过"

    log(f"环境 ENV_ID : {env}")
    log(f"函数总数    : {len(every)}")
    log(f"本次范围    : {why} → {len(target)} 个")

    if not target:
        log("\n没有需要部署的函数。（想全传就加 --all）")
        return 0

    log("\n待部署：")
    for n in target:
        log(f"  · {n}")

    if args.dry_run:
        log("\n--dry-run：未执行。")
        return 0

    log("")
    failed, out = deploy(target, env,
                         remote_install=not args.local_deps,
                         timeout=args.timeout)
    log(out.strip())

    if failed is None:
        return 1  # 兜底：deploy 内部异常路径
    done = [n for n in target if n not in failed]
    if not failed:
        record_deployed(done)
        log(f"\n✓ 部署完成：{len(done)} 个函数")
        return 0
    if done:
        record_deployed(done)
        log(f"\n△ 部分成功：{len(done)} 个（{', '.join(done)}）已记录")
    log(f"\n✗ 部署失败：{len(failed)} 个 → {', '.join(sorted(failed))}")
    if "getCloudAPISignedHeader" in out or "41002" in out:
        log("\n  这是 IDE 的云开发会话签名失败（非代码问题）。按顺序试：")
        log("  ① 开发者工具里点开「云开发」控制台，等它完全加载后关掉，再重试本脚本")
        log("  ② 重启微信开发者工具再重试")
        log("  ③ 仍失败 → 工具里右键函数目录「上传并部署：云端安装依赖」手动传")
    return 1


if __name__ == "__main__":
    sys.exit(main())
