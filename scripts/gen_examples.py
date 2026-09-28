#!/usr/bin/env python3
"""
gen_examples.py —— 离线批量生成例句（DeepSeek），供本地合成例句语音

为什么要在本地离线跑一遍：
  例句原本由云函数 enrich_word 在「用户首次学到该词」时**运行时**调 DeepSeek 生成。
  但要让例句也能本地预生成语音，就必须在合成音频之前拿到确定的例句文本——
  运行时才产生的文本，本地提前无从合成。
  所以把这一步搬到离线：例句文本 + 语音 + 索引一起预先做好，运行时零外呼。

与云端的一致性：
  prompt / model / temperature / max_tokens 均与 cloudfunctions/enrich_word 对齐，
  离线产出的例句质量与「云端现生成」一致。
  同时顺带把 roots / etymology 也存下来（同一次请求本就会返回）——
  将来若想彻底消除运行时的 AI 调用，可直接用这份 JSON 回填 words 集合。

用法：
  export DEEPSEEK_API_KEY=sk-xxxx
  python scripts/gen_examples.py --wordlist assets/word_lists/pilot-100.json
  # 已生成的词自动跳过，失败的重跑即可补齐；--force 强制重生成

输出：
  assets/examples/{词表名}-examples.json
  [{ "word", "example": {"en","cn"}, "roots": [...], "etymology" }, ...]

  ⚠️ 这份 JSON 是词表级资产（不是临时产物），应随仓库保留。
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
ENDPOINT = os.environ.get("DEEPSEEK_ENDPOINT", "https://api.deepseek.com/chat/completions")
TIMEOUT_S = float(os.environ.get("DEEPSEEK_TIMEOUT_MS", "45000")) / 1000.0
MAX_ATTEMPTS = 3


def load_env_file(path=".env"):
    """极简 .env 读取（不引入第三方依赖）。

    让密钥可以放在项目根的 .env 里（该文件已在 .gitignore 中），
    避免在命令行 / 脚本里写明文。**已存在的环境变量优先，绝不覆盖**。
    """
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


# ⚠️ 与 cloudfunctions/enrich_word/index.js 的 buildPrompt 逐字对齐，勿单独改
# 占位符刻意用 __NAME__ 而非 str.format()：模板里塞着 JSON，花括号成对出现，
# 用 .format() 必须把每个 { } 转义成 {{ }}，漏一个就报 KeyError（曾踩过）。
PROMPT_TMPL = (
    '你是雅思词汇教学专家。请为单词 "__WORD__"（词性 __POS__，释义：__MEANING__）生成学习卡片内容。\n'
    '严格只返回一个 json 对象，不要输出任何多余文字、解释或 Markdown 代码块：\n'
    '{\n'
    '  "example": { "en": "英文例句（不超过20词）", "cn": "中文翻译" },\n'
    '  "roots": [ { "part": "ab-", "type": "prefix", "meaning": "含义" } ],\n'
    '  "etymology": "词源演变简述（不超过60字）"\n'
    '}\n'
    '要求：\n'
    '1) 例句贴近雅思学术或生活场景；\n'
    '2) 词根拆解要准确，type 取值 prefix/root/suffix；若该词无明显词根，roots 返回空数组 []；\n'
    '3) 词源简明通俗。'
)


def build_prompt(w):
    return (PROMPT_TMPL
            .replace("__WORD__", str(w.get("word", "")))
            .replace("__POS__", str(w.get("pos") or "-"))
            .replace("__MEANING__", str(w.get("meaning") or "-")))


def strip_fence(text):
    t = str(text).strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else ""
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def call_model(w, api_key):
    """单次请求 DeepSeek（JSON Output 模式）。"""
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": build_prompt(w)}],
        "temperature": 0.3,
        "max_tokens": 800,
        "stream": False,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")

    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    choices = payload.get("choices") or []
    content = ((choices[0] if choices else {}).get("message") or {}).get("content") or ""
    if not content:
        raise RuntimeError("EMPTY_MODEL_RESPONSE")
    return content


def fatal_error(msg):
    """鉴权 / 余额 / 请求错误：重试没有意义，直接终止。"""
    return any(k in msg for k in (
        "401", "402", "Unauthorized", "Insufficient Balance",
        "Authentication Fails", "invalid_api_key",
    ))


def gen_one(w, api_key):
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            parsed = json.loads(strip_fence(call_model(w, api_key)))

            ex = parsed.get("example") or {}
            en = (ex.get("en") or "").strip()
            if not en:
                raise RuntimeError("EMPTY_EXAMPLE")

            roots = parsed.get("roots")
            if not isinstance(roots, list):
                roots = []

            return {
                "word": w["word"],
                "example": {"en": en, "cn": (ex.get("cn") or "").strip()},
                "roots": roots[:6],
                "etymology": parsed.get("etymology") if isinstance(parsed.get("etymology"), str) else "",
            }
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:200]
            except Exception:
                pass
            last = RuntimeError(f"HTTP {e.code}: {detail}")
            if fatal_error(str(last)):
                break
        except Exception as e:
            last = e
            if fatal_error(str(e)):
                break
        if attempt < MAX_ATTEMPTS:
            time.sleep(1.5 * attempt)
    raise last if last else RuntimeError("UNKNOWN")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wordlist", required=True, help="build_wordlist.py 产出的 JSON")
    ap.add_argument("--out", default="", help="输出路径，默认 assets/examples/{词表名}-examples.json")
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0, help="0 表示全部")
    ap.add_argument("--workers", type=int, default=4, help="并发请求数")
    ap.add_argument("--force", action="store_true", help="已存在的词也重新生成")
    args = ap.parse_args()

    # 密钥来源优先级：环境变量 > 项目根 .env（.env 已在 .gitignore 中）
    load_env_file()
    global MODEL, ENDPOINT, TIMEOUT_S
    MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
    ENDPOINT = os.environ.get("DEEPSEEK_ENDPOINT", "https://api.deepseek.com/chat/completions")
    TIMEOUT_S = float(os.environ.get("DEEPSEEK_TIMEOUT_MS", "45000")) / 1000.0

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        sys.exit(
            "缺少 DEEPSEEK_API_KEY。两种设置方式：\n"
            "  1) export DEEPSEEK_API_KEY=sk-xxxx\n"
            "  2) 在项目根建 .env，写入一行 DEEPSEEK_API_KEY=sk-xxxx（该文件已被 .gitignore 忽略）"
        )

    if not os.path.isfile(args.wordlist):
        sys.exit(f"找不到词表：{args.wordlist}")

    with open(args.wordlist, "r", encoding="utf-8") as f:
        all_words = json.load(f)

    stem = os.path.splitext(os.path.basename(args.wordlist))[0]
    out_path = args.out or os.path.join("assets", "examples", f"{stem}-examples.json")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)

    # 断点续跑：读回已有结果
    existing = {}
    if os.path.isfile(out_path) and not args.force:
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                for item in json.load(f):
                    existing[item["word"]] = item
        except Exception as e:
            print(f"⚠️ 已有结果读取失败，将全部重生成：{e}")

    batch = all_words[args.offset: args.offset + args.limit] if args.limit > 0 \
        else all_words[args.offset:]

    todo = [w for w in batch if w.get("word") and w["word"] not in existing]
    print(f"词表 {len(all_words)} 词 | 本次区间 {len(batch)} 词 | 已有 {len(existing)} 条 | 待生成 {len(todo)} 条")

    if not todo:
        print("没有需要生成的词。")
        return

    results = dict(existing)
    failed = []
    t0 = time.time()
    done = 0

    def save():
        ordered = [results[w["word"]] for w in all_words if w.get("word") in results]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(ordered, f, ensure_ascii=False, indent=2)

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(gen_one, w, api_key): w for w in todo}
        for fut in as_completed(futures):
            w = futures[fut]
            done += 1
            try:
                results[w["word"]] = fut.result()
            except Exception as e:
                failed.append({"word": w["word"], "error": str(e)[:200]})
            if done % 10 == 0 or done == len(todo):
                el = time.time() - t0
                print(f"  {done}/{len(todo)}  成功 {len(results) - len(existing)}  失败 {len(failed)}  ({el:.0f}s)")
                save()

    save()

    print(f"\n完成：生成 {len(results) - len(existing)} 条，失败 {len(failed)} 条")
    print(f"输出 → {out_path}")
    if failed:
        fpath = os.path.join(os.path.dirname(os.path.abspath(out_path)), f"{stem}-examples-failed.json")
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump(failed, f, ensure_ascii=False, indent=2)
        print(f"⚠️ 失败清单 → {fpath}（直接重跑本脚本即可补齐）")
    print("下一步：python scripts/gen_sentence_audio.py --examples " + out_path)


if __name__ == "__main__":
    main()
