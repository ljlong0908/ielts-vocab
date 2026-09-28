#!/usr/bin/env python3
"""
install_spacy_model.py —— 装 spaCy 英文小模型 en_core_web_sm（境内网络专用路径）

为什么需要这个脚本
------------------
Kokoro 的英文 G2P 走 misaki，misaki/en.py 里写死了：

    name = f"en_core_web_{'trf' if trf else 'sm'}"
    if not spacy.util.is_package(name):
        spacy.cli.download(name)          # ← 去 raw.githubusercontent.com 拉
    self.nlp = spacy.load(name, enable=[...])

`spacy.cli.download()` 先请求 raw.githubusercontent.com 上的 compatibility.json，
该域名在境内不可达，于是 KPipeline 初始化直接抛 ProxyError。

而且 en_core_web_sm **不在 PyPI 上**（`pip install en-core-web-sm` 会报
No solution found），官方只发在 GitHub Releases。

本脚本的做法：从 HuggingFace 镜像（spacy/en_core_web_sm 仓库）取 wheel，
但它下载下来叫 `en_core_web_sm-any-py3-none-any.whl` —— 版本字段 "any" 不合
PEP 427，pip 会拒绝（Invalid wheel filename (invalid version)），
因此读出 wheel 内 dist-info 的真实版本号重命名后再装。

用法
----
  export HF_ENDPOINT=https://hf-mirror.com
  /Users/lijinlong/.workbuddy/binaries/python/envs/default/bin/python \
      scripts/install_spacy_model.py

成功后 spacy.util.is_package('en_core_web_sm') 返回 True，gen_audio.py 即可运行。
"""
import glob
import os
import re
import shutil
import subprocess
import sys
import zipfile

# 允许用环境变量覆盖解释器路径（换机器时用）
PYTHON = os.environ.get(
    "IELTS_VOCAB_PYTHON",
    "/Users/lijinlong/.workbuddy/binaries/python/envs/default/bin/python",
)

ENDPOINT = os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# spacy 官方在 HF 上的镜像仓库；前两个不通会自动尝试后面的
CANDIDATES = [
    "spacy/en_core_web_sm",
    "explosion/en_core_web_sm",
    "davidbrochart/en_core_web_sm",
]


def already_installed():
    r = subprocess.run(
        [PYTHON, "-c",
         "import spacy; print(spacy.util.is_package('en_core_web_sm'))"],
        capture_output=True, text=True)
    return "True" in (r.stdout or "")


def fetch_wheel():
    from huggingface_hub import hf_hub_download, list_repo_files

    for repo in CANDIDATES:
        try:
            files = list_repo_files(repo)
        except Exception as e:
            print(f"  [跳过] {repo}: {type(e).__name__}: {e}")
            continue
        names = [f for f in files if f.endswith(".whl")]
        if not names:
            print(f"  [跳过] {repo}: 仓库内没有 wheel")
            continue
        print(f"  [命中] {repo} -> {names[0]}")
        path = hf_hub_download(repo, names[0])
        print(f"  [已下载] {path}")
        return path
    return None


def normalize_and_install(src):
    """HF 上的 wheel 版本字段是 any，需按 dist-info 里真实版本改名后安装。"""
    with zipfile.ZipFile(src) as z:
        metas = [n for n in z.namelist() if n.endswith(".dist-info/METADATA")]

    version = None
    for n in metas:
        m = re.match(r"en_core_web_sm-([^-]+)\.dist-info/METADATA", n)
        if m:
            version = m.group(1)
            break
    if not version:
        sys.exit(f"无法从 wheel 解析版本号（dist-info: {metas}）")

    dst = os.path.join(os.path.dirname(src),
                       f"en_core_web_sm-{version}-py3-none-any.whl")
    if not os.path.exists(dst):
        shutil.copy2(src, dst)
    print(f"  [改名] 版本 {version} -> {os.path.basename(dst)}")

    r = subprocess.run(
        [PYTHON, "-m", "pip", "install", "--no-deps", "--force-reinstall", dst],
        capture_output=True, text=True)
    tail = (r.stdout or "")[-800:] + (r.stderr or "")[-800:]
    print("  " + tail.replace("\n", "\n  ").strip())
    return r.returncode == 0


def verify():
    code = ("import spacy; print('is_package:', spacy.util.is_package('en_core_web_sm')); "
            "nlp = spacy.load('en_core_web_sm', enable=['tok2vec', 'tagger']); "
            "print('tags:', [t.tag_ for t in nlp('council community issue')])")
    r = subprocess.run([PYTHON, "-c", code], capture_output=True, text=True)
    print("  [校验]", (r.stdout or "").strip())
    if r.returncode != 0:
        print("  [stderr]", (r.stderr or "")[-800:])
    return r.returncode == 0


def main():
    print(f"HF 镜像：{ENDPOINT}")
    print(f"解释器：{PYTHON}")

    if already_installed():
        print("en_core_web_sm 已安装，跳过。")
        return verify()

    print("1) 从 HF 镜像获取 wheel ...")
    src = fetch_wheel()
    if not src:
        sys.exit("候选仓库都取不到 wheel，请检查网络 / HF_ENDPOINT")

    print("2) 修正文件名并安装 ...")
    if not normalize_and_install(src):
        sys.exit("安装失败")

    print("3) 校验 ...")
    ok = verify()
    print("\n完成。" if ok else "\n装上了但加载失败，请检查 spaCy 版本兼容性。")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
