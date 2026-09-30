/**
 * 原型交互回归 · design/prototype.html
 *
 * 用法：node scripts/test_prototype.js
 *
 * 与 scripts/audit_mobile.js 的分工：
 *   audit_mobile.js  → 移动端体验（热区 / 对比度 / 安全区 / toast 落点 / 可达性）
 *   test_prototype.js → 业务流程（逐词推进 / 答错重选 / 打卡 / 加练 / 边界态 / 连点保护）
 *
 * 每个用例都自带复位，不依赖「上一步应该是什么状态」（长流程用例互相污染是踩过的坑）。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const PROTOTYPE = path.join(ROOT, 'design', 'prototype.html')
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const C = {
  ok: (s) => '\u001b[32m' + s + '\u001b[0m',
  bad: (s) => '\u001b[31m' + s + '\u001b[0m',
  dim: (s) => '\u001b[2m' + s + '\u001b[0m',
  b: (s) => '\u001b[1m' + s + '\u001b[0m'
}

/* ================================================================== */
/* harness：在页面里跑，直接调页面自己的函数（即 inline onclick 的处理函数） */
/* ================================================================== */
const HARNESS = String.raw`
;(function () {
  var R = []
  function ok(name, cond, detail) { R.push({ name: name, pass: !!cond, detail: detail == null ? '' : String(detail) }) }
  function eq(name, got, expect) { ok(name, got === expect, 'got ' + got + ' / expect ' + expect) }
  function q(sel) { return document.querySelector(sel) }
  function qa(sel) { return [].slice.call(document.querySelectorAll(sel)) }
  function ctaText() { return q('#s-index .bottom .btn.primary').textContent.trim() }
  function pick(i) { qa('#qOptions .option')[i].onclick() }
  // 「连点保护」是真实产品行为，但会吞掉测试里的连续调用（同一 tick 内 lastAct 不会过期）。
  // 所以凡是要连续推进的操作，都先清零时间戳再调；连点保护本身在 ⑨ 用真实调用单独验证。
  function fire(fn) { lastAct = 0; return fn() }

  try {
    // ---------- ① 初始态 ----------
    resetAll()
    eq('初始 CTA 文案', ctaText(), '开始今日学习')
    eq('初始今日进度', document.getElementById('iTag').textContent, '2 / 5')
    eq('页面总数', qa('.screen').length, 8)

    // ---------- ② 学习页：逐词推进 + 两个边界态 ----------
    openPage('s-learn')
    eq('学习页首词', document.getElementById('lWord').textContent, 'abandon')
    eq('首词按钮文案', document.getElementById('lNext').textContent, '下一个')
    learnIdx = 4; renderLearn()
    ok('第 5 词例句显示「暂缺」', document.getElementById('lExCard').textContent.indexOf('暂缺') >= 0, document.getElementById('lExCard').textContent.trim().slice(0, 24))
    learnIdx = 5; renderLearn()
    ok('第 6 词显示「生成中」提示', document.getElementById('lEnrichTip').style.display === 'block')
    eq('末词按钮变「开始练习」', document.getElementById('lNext').textContent, '开始练习')

    // ---------- ③ 学完 → 练习，今日进度补满 ----------
    fire(learnNext)
    eq('学完跳练习页', current, 's-practice')
    eq('学完补满今日进度', state.learnedToday, state.dailyGoal)
    eq('主流程阶段 = practice', practicePhase, 'practice')

    // ---------- ④ 练习四态：答错可重选、答对才放行 ----------
    resetPractice('practice'); go('s-practice')
    eq('选项渲染 4 个', qa('#qOptions .option').length, 4)
    pick(1)
    ok('答错标出正确答案', qa('#qOptions .option')[QUESTIONS[0].answer].classList.contains('answer'))
    ok('答错不放行「下一题」', document.getElementById('pNext').classList.contains('disabled'))
    pick(1)
    ok('重复点已错项被拦', q('#toast').textContent.indexOf('选过了') >= 0, q('#toast').textContent)
    pick(0)
    ok('答对放行「下一题」', !document.getElementById('pNext').classList.contains('disabled'))
    pick(2)
    ok('答对后不可改选', !qa('#qOptions .option')[2].classList.contains('bad'))

    // ---------- ⑤ 做完 4 题 → 打卡（连续天数 / 累计打卡各 +1） ----------
    var s0 = state.streak, ck0 = state.totalCheckins
    var trace = []
    for (var i = 0; i < QUESTIONS.length; i++) {
      pick(QUESTIONS[qi].answer)
      trace.push('q' + qi + (answered ? '✓' : '✗'))
      fire(practiceNext)
    }
    ok('练习推进到打卡页', current === 's-checkin', trace.join(' → ') + ' | 落点 ' + current)
    eq('连续天数 +1', state.streak, s0 + 1)
    eq('累计打卡 +1', state.totalCheckins, ck0 + 1)
    eq('打卡页显示新连续天数', document.getElementById('ckStreak').textContent, String(state.streak))

    // ---------- ⑥ 边界态：今日已完成 → CTA 换语义并去复习 ----------
    resetAll(); sceneDone()
    eq('已完态 CTA 文案', ctaText(), '今日已完成 · 去复习错题')
    fire(function () { startLearn(false) })
    eq('已完态 CTA 去错题本', current, 's-wrongbook')

    // ---------- ⑦ 加练：走 extra 阶段、不回写主进度 ----------
    resetAll()
    fire(function () { startLearn(true) })
    eq('加练进入学习页', current, 's-learn')
    eq('加练标识', document.getElementById('lPhase').textContent, '加练新词')
    var today0 = state.learnedToday
    learnIdx = LEARN_WORDS.length - 1; renderLearn()
    fire(learnNext)
    eq('加练学完进练习', current, 's-practice')
    eq('加练阶段 = extra（对应后端 round）', practicePhase, 'extra')
    eq('加练不回写主进度', state.learnedToday, today0)

    // ---------- ⑧ 错题本「再练一遍」闭环 ----------
    resetAll(); openPage('s-wrongbook'); practiceWrong()
    eq('再练进入练习页', current, 's-practice')
    eq('错题重练阶段 = wrong', practicePhase, 'wrong')
    for (var j = 0; j < QUESTIONS.length; j++) { pick(QUESTIONS[qi].answer); fire(practiceNext) }
    eq('错题重练完回错题本', current, 's-wrongbook')

    // ---------- ⑨ 连点保护（真实调用，不 fire） ----------
    resetAll(); lastAct = 0
    openPage('s-learn'); learnNext(); learnNext()
    eq('连点「下一个」只进一步', learnIdx, 1)
    var s1 = state.streak
    lastAct = 0
    openPage('s-checkin'); doCheckin(); doCheckin()
    eq('连点打卡只加一天', state.streak, s1 + 1)

    // ---------- ⑩ toast 不被底部固定区遮住 ----------
    resetAll(); openPage('s-index')
    toast('探测')
    var tv = parseFloat(getComputedStyle(document.getElementById('toast')).bottom)
    var bh = q('#s-index .bottom').getBoundingClientRect().height
    ok('toast 落在底栏之上', tv > bh, 'toast bottom=' + tv + ' / 底栏高=' + bh)
    resetAll()

    // ---------- ⑪ 复位干净 ----------
    eq('复位今日进度', state.learnedToday, 2)
    eq('复位连续天数', state.streak, 7)
    eq('复位后 CTA 文案', ctaText(), '开始今日学习')
  } catch (e) {
    R.push({ name: 'harness 整体执行', pass: false, detail: e.message + ' @ ' + String((e.stack || '').split('\n')[1]).trim() })
  }

  window.__R__ = R
  var pre = document.createElement('pre')
  pre.id = '__result__'
  pre.textContent = JSON.stringify(R).replace(/</g, '\\u003c')
  document.body.appendChild(pre)
})();
`

/* ================================================================== */
function runHeadless(html) {
  const dir = '/tmp/cr_proto_' + Date.now()
  const page = '/tmp/ielts_proto_test.html'
  fs.writeFileSync(page, html.replace('</body>', '<script>' + HARNESS + '</script>\n</body>'), 'utf8')

  return new Promise((resolve) => {
    const cp = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--user-data-dir=' + dir,
        '--virtual-time-budget=6000',
        '--dump-dom',
        'file://' + page
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    let idle = null
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(idle)
      clearTimeout(hard)
      try { cp.kill('SIGKILL') } catch (e) {}
      try { execFileSync('pkill', ['-f', dir], { stdio: 'ignore' }) } catch (e) {}
      resolve(out)
    }
    cp.stdout.on('data', (d) => {
      out += d.toString()
      clearTimeout(idle)
      idle = setTimeout(finish, 1200)
    })
    cp.on('close', finish)
    cp.on('error', finish)
    const hard = setTimeout(finish, 40000)
  })
}

function extract(dom) {
  const m = /<pre id="__result__">([\s\S]*?)<\/pre>/.exec(dom)
  if (!m) return null
  const txt = m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  try { return JSON.parse(txt) } catch (e) { return null }
}

;(async () => {
  const html = fs.readFileSync(PROTOTYPE, 'utf8')
  console.log(C.b('\n=== 原型交互回归 · design/prototype.html ===\n'))
  try { new Function(HARNESS) } catch (e) {
    console.log(C.bad('✗ harness 语法错误：' + e.message))
    process.exit(2)
  }

  const dom = await runHeadless(html)
  const res = extract(dom)
  if (!res) {
    console.log(C.bad('✗ 未取到结果（Chrome 未跑通或 harness 未执行）') + C.dim('  DOM ' + dom.length + ' 字符'))
    process.exit(2)
  }

  let pass = 0, fail = 0
  res.forEach((r) => {
    const okk = r.pass
    okk ? pass++ : fail++
    console.log('  ' + (okk ? C.ok('PASS') : C.bad('FAIL')) + '  ' + r.name.padEnd(30) + C.dim(okk ? '' : r.detail))
  })
  console.log('\n  ' + (fail ? C.bad(pass + ' passed, ' + fail + ' failed') : C.ok(pass + ' passed, 0 failed')))
  process.exit(fail ? 1 : 0)
})()
