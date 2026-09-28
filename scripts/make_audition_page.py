#!/usr/bin/env python3
"""
make_audition_page.py —— 生成本地「音频试听页」+ 上传前预检

为什么需要它
------------
音频在本地生成后，直接上传到云端才发现问题（读错、空文件、文件名不合规）
是浪费。本脚本在**不碰云端**的前提下做两件事：

  1. 预检（在终端打印 + 页面上显示）：词表/音频对不上、mp3 头非法、
     文件名会不会被云函数的正则拒绝、slug 是否撞车等
  2. 生成 build/audition.html —— 一个自包含的试听页，逐条播放 + 标记存疑词，
     把结果导出成待重生成的词表

用法：
  # 单词发音
  python scripts/make_audition_page.py
  python scripts/make_audition_page.py --wordlist assets/word_lists/pilot-100.json
  python scripts/make_audition_page.py --types us --open    # 顺带用浏览器打开

  # 例句发音（--examples 一给就切到例句模式）
  python scripts/make_audition_page.py --examples assets/examples/pilot-100-examples.json --open

产出：
  build/audition.html            单词试听页（双击即可在浏览器里试听）
  build/audition_check.json      单词预检明细（机器可读）
  build/audition_sentence.html   例句试听页
  build/audition_sentence_check.json
"""
import argparse
import json
import os
import re
import sys

# 与 cloudfunctions/audio_cache、seed_audio 保持完全一致的入参口径
TEXT_RE = re.compile(r"^[A-Za-z][A-Za-z'\u2019\- ]{0,39}$")
# 例句：字母开头，长度 1–200，允许「除控制字符 / 反斜杠 / 反引号」外的可打印字符。
# 用排除集而非逐个列举标点：真实例句里出现过 `%`（"over 70% of ..."），
# 白名单每漏一个标点，该例句的音频就查不到；且这条正则要与 seed_audio /
# audio_cache 两处同步，白名单极易漏改。
TEXT_RE_SENTENCE = re.compile(r"^[A-Za-z][^\x00-\x1F\x7F\\`]{0,199}$")

# 复用 hash / slug 命名逻辑（与 gen_audio.py、gen_sentence_audio.py、seed_audio 同源，
# 不在此处另写一份实现，否则又多一处必须手工保持同步的地方）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_audio import slug  # noqa: E402
from gen_sentence_audio import sentence_slug  # noqa: E402


def is_mp3(path):
    """粗略校验 mp3 文件头：要么 ID3 标签开头，要么直接是 MPEG 帧同步字。"""
    with open(path, "rb") as f:
        head = f.read(4)
    if len(head) < 3:
        return False, "文件过短"
    if head[:3] == b"ID3":
        return True, "ID3"
    if head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return True, "MPEG帧"
    return False, f"头字节异常 {head.hex()}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wordlist", default="assets/word_lists/pilot-100.json",
                    help="单词模式：词表 JSON")
    ap.add_argument("--examples", default="",
                    help="例句模式：gen_examples.py 产出的 JSON（给了它就切到例句模式）")
    ap.add_argument("--audiodir", default="", help="默认按模式取 build/audio 或 build/sentence_audio")
    ap.add_argument("--types", default="us", help="us / uk，默认 us")
    ap.add_argument("--out", default="", help="默认 build/audition.html 或 build/audition_sentence.html")
    ap.add_argument("--open", action="store_true", help="生成后用默认浏览器打开")
    args = ap.parse_args()

    sentence_mode = bool(args.examples)
    if sentence_mode:
        src_path = args.examples
        if not os.path.isfile(src_path):
            sys.exit(f"找不到例句文件 {src_path}（先跑 scripts/gen_examples.py）")
        audiodir = args.audiodir or "build/sentence_audio"
        out_path = args.out or "build/audition_sentence.html"
        check_path = "build/audition_sentence_check.json"
    else:
        src_path = args.wordlist
        if not os.path.isfile(src_path):
            sys.exit(f"找不到词表 {src_path}")
        audiodir = args.audiodir or "build/audio"
        out_path = args.out or "build/audition.html"
        check_path = "build/audition_check.json"

    with open(src_path, "r", encoding="utf-8") as f:
        rows_in = json.load(f)

    kind = args.types.split(",")[0].strip()
    mp3dir = os.path.join(audiodir, kind)
    if not os.path.isdir(mp3dir):
        sys.exit(f"找不到音频目录 {mp3dir}，请先跑 scripts/gen_audio.py 或 gen_sentence_audio.py")

    # ---------------- 预检 ----------------
    rows, problems = [], []
    owner = {}
    total_bytes = 0
    abs_outdir = os.path.dirname(os.path.abspath(out_path))

    for w in rows_in:
        issues = []

        if sentence_mode:
            word = w.get("word") or ""
            ex = w.get("example") or {}
            text = (ex.get("en") or "").strip()
            key = text
            name = sentence_slug(text)
            label, sub, extra = text, (ex.get("cn") or "").strip(), word
            # 正则：这一关不过，seed_audio 云端直接抛 INVALID_SENTENCE
            if not text:
                issues.append("缺例句文本")
            elif not TEXT_RE_SENTENCE.match(text):
                issues.append(f"例句不合规（{len(text)} 字符，含非法字符或超 200）")
        else:
            word = w["word"]
            key = word
            name = slug(word)
            label = word
            sub = (w.get("meaning") or "").replace("\n", " ")
            extra = w.get("phoneticUS") or w.get("phonetic") or ""
            # 正则：这一关不过，seed_audio / audio_cache 云端直接抛 INVALID_WORD
            if not TEXT_RE.match(word):
                issues.append("词名不符合云函数正则 TEXT_RE")

        # 文件名撞车：不同文本算出同一文件名会互相覆盖
        if name in owner and owner[name] != key:
            issues.append(f"文件名撞车：与「{owner[name][:40]}」同 slug {name}")
        owner[name] = key

        path = os.path.join(mp3dir, f"{name}.mp3")
        rel = os.path.relpath(path, abs_outdir)

        # 文件存在性 + 头部 + 体积
        size = 0
        mtype = "-"
        if not os.path.isfile(path):
            issues.append("音频缺失")
        else:
            size = os.path.getsize(path)
            total_bytes += size
            ok, mtype = is_mp3(path)
            if not ok:
                issues.append(f"mp3 非法（{mtype}）")
            if size < (1500 if sentence_mode else 500):
                issues.append(f"体积过小（{size}B，疑似空音频）")
            if size > 100 * 1024:
                issues.append(f"体积过大（{size}B，疑似多条拼接）")

        rows.append({
            "seq": w.get("seq"), "key": key, "label": label, "sub": sub,
            "extra": extra, "rel": rel, "size": size, "mtype": mtype,
            "issues": issues,
        })
        if issues:
            problems.append({"word": word, "key": key, "issues": issues})

    n_ok = len(rows) - len(problems)
    unit = "条" if sentence_mode else "词"

    print("=" * 68)
    print(f"音频预检：{src_path}（{kind}）")
    print("=" * 68)
    print(f"来源      {len(rows_in)} {unit}")
    print(f"音频目录  {mp3dir}")
    print(f"通过      {n_ok} {unit}")
    print(f"有问题    {len(problems)} {unit}")
    print(f"合计体积  {total_bytes / 1024:.1f} KB"
          f"（均值 {total_bytes / max(n_ok, 1) / 1024:.1f} KB/{unit}）")
    if problems:
        print("-" * 68)
        for p in problems[:20]:
            print(f"  ✗ {p['word']}: {'；'.join(p['issues'])}")
        if len(problems) > 20:
            print(f"  ...（其余 {len(problems) - 20} 条见 {check_path}）")
    else:
        print("  ✓ 全部通过，可以上传")

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(check_path, "w", encoding="utf-8") as f:
        json.dump({"source": src_path, "kind": kind, "mode": "sentence" if sentence_mode else "word",
                   "total": len(rows), "ok": n_ok, "problems": problems},
                  f, ensure_ascii=False, indent=2)

    # ---------------- 生成试听页 ----------------
    rows.sort(key=lambda r: (r["seq"] is None, r["seq"]))

    items_html = []
    for i, r in enumerate(rows, 1):
        badge = ""
        if "音频缺失" in r["issues"]:
            badge = '<span class="badge bad">无音频</span>'
        elif r["issues"]:
            badge = '<span class="badge bad">异常</span>'
        else:
            badge = f'<span class="badge ok">{r["size"] // 1024 or 1}KB</span>'

        src = "" if "音频缺失" in r["issues"] else f'data-src="{r["rel"]}"'
        items_html.append(
            '<div class="row" data-key="{key}" data-issues="{issues}">'
            '<span class="idx">{i}</span>'
            '<button class="play" {src}>&#9654;</button>'
            '<div class="txt"><div class="w">{label}'
            '<span class="ph">{extra}</span></div>'
            '<div class="mn">{sub}</div></div>'
            '{badge}'
            '<label class="chk"><input type="checkbox" onchange="toggleMark(this)">存疑</label>'
            "</div>".format(
                i=i, key=r["key"], label=r["label"], extra=r["extra"], sub=r["sub"],
                badge=badge, src=src, issues="；".join(r["issues"]),
            )
        )

    html = PAGE.replace("__ITEMS__", "\n".join(items_html)) \
               .replace("__TOTAL__", str(len(rows))) \
               .replace("__OK__", str(n_ok)) \
               .replace("__BAD__", str(len(problems))) \
               .replace("__KB__", f"{total_bytes / 1024:.0f}") \
               .replace("__UNIT__", unit) \
               .replace("__KIND__", kind) \
               .replace("__WL__", os.path.basename(src_path)) \
               .replace("__MODE__", "例句" if sentence_mode else "单词")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\n试听页已生成：{out_path}")
    print("  直接双击打开即可（无需服务器）；点 ▶ 试听，读错/读不出就勾「存疑」。")
    print("  页面右上角「导出存疑清单」会把勾选条目的文本复制到剪贴板。")

    if args.open:
        import subprocess
        subprocess.run(["open", os.path.abspath(out_path)], check=False)


PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>雅词本 · 音频试听（__WL__ · __KIND__）</title><style>
  :root { --bg:#f6f7f9; --card:#fff; --line:#e5e7eb; --tx:#1f2328; --dim:#6b7280;
          --ok:#0f7b3f; --bad:#c0392b; --acc:#2f6fed; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--tx);
         font:15px/1.6 -apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif; }
  header { position:sticky; top:0; z-index:9; background:var(--card);
           border-bottom:1px solid var(--line); padding:14px 20px; }
  h1 { margin:0 0 8px; font-size:17px; }
  .stat { color:var(--dim); font-size:13px; }
  .stat b { color:var(--tx); }
  .actions { margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; }
  button.act { border:1px solid var(--line); background:#fff; color:var(--tx);
               border-radius:8px; padding:6px 14px; font-size:13px; cursor:pointer; }
  button.act:hover { border-color:var(--acc); color:var(--acc); }
  main { max-width:860px; margin:0 auto; padding:16px 20px 60px; }
  .row { display:flex; align-items:center; gap:12px; background:var(--card);
         border:1px solid var(--line); border-radius:10px; padding:10px 14px;
         margin-bottom:8px; }
  .row.marked { border-color:#f0b429; background:#fffdf5; }
  .idx { width:28px; color:var(--dim); font-size:12px; text-align:right; }
  button.play { flex:0 0 auto; width:38px; height:38px; border-radius:50%;
                border:1px solid var(--line); background:#fff; color:var(--acc);
                font-size:13px; cursor:pointer; }
  button.play:hover { background:var(--acc); color:#fff; border-color:var(--acc); }
  button.play:disabled { opacity:.35; cursor:not-allowed; }
  .txt { flex:1; min-width:0; }
  .w { font-weight:600; font-size:16px; }
  .ph { margin-left:10px; font-weight:400; color:var(--dim); font-size:13px; }
  .mn { color:var(--dim); font-size:12.5px; overflow:hidden; text-overflow:ellipsis;
        white-space:nowrap; }
  .badge { flex:0 0 auto; font-size:11px; padding:2px 8px; border-radius:20px; }
  .badge.ok { background:#e8f6ee; color:var(--ok); }
  .badge.bad { background:#fdecea; color:var(--bad); }
  .chk { flex:0 0 auto; font-size:12.5px; color:var(--dim); user-select:none; }
  .toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%);
           background:#1f2328; color:#fff; padding:9px 18px; border-radius:8px;
           font-size:13px; opacity:0; transition:opacity .25s; pointer-events:none; }
  .toast.show { opacity:1; }
</style>
</head>
<body>
<header>
  <h1>雅词本 · 音频试听（__MODE__）</h1>
  <div class="stat">来源 <b>__WL__</b> ｜ 音源 <b>__KIND__</b> ｜ 共 <b>__TOTAL__</b> __UNIT__ ｜
    通过 <b>__OK__</b> ｜ 异常 <b>__BAD__</b> ｜ 合计 <b>__KB__</b> KB</div>
  <div class="actions">
    <button class="act" onclick="exportMarked()">导出存疑清单</button>
    <button class="act" onclick="clearMarked()">清空标记</button>
    <span class="stat" style="align-self:center">读出不对/听不清就勾「存疑」，最后一次性导出重生成</span>
  </div>
</header>
<main>__ITEMS__</main>
<div class="toast" id="toast"></div>
<script>
  var ctx = null;
  document.querySelectorAll('button.play').forEach(function (b) {
    b.addEventListener('click', function () {
      var src = b.getAttribute('data-src');
      if (!src) return;
      if (ctx) ctx.pause();
      ctx = new Audio(src);
      ctx.play().catch(function (e) {
        toast('播放失败：' + e.message + '（若是浏览器限制，请直接双击 html 打开）');
      });
    });
  });
  function toggleMark(cb) {
    cb.closest('.row').classList.toggle('marked', cb.checked);
  }
  function markedWords() {
    return [].slice.call(document.querySelectorAll('.row.marked')).map(function (r) {
      return r.getAttribute('data-key');
    });
  }
  function exportMarked() {
    var ws = markedWords();
    if (!ws.length) { toast('还没勾选任何词'); return; }
    var text = JSON.stringify(ws, null, 2);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        toast('已复制 ' + ws.length + ' 条到剪贴板');
      }, function () { fallback(text); });
    } else { fallback(text); }
  }
  function fallback(text) {
    window.prompt('手动复制下面的数组：', text);
  }
  function clearMarked() {
    document.querySelectorAll('.row.marked').forEach(function (r) {
      r.classList.remove('marked');
      r.querySelector('input').checked = false;
    });
    toast('已清空标记');
  }
  var t = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(t); t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }
</script>
</body>
</html>
"""

if __name__ == "__main__":
    main()
