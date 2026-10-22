/**
 * 移动端体验审核（Mobile UX Audit）· design/prototype.html
 *
 * 用法：node scripts/audit_mobile.js
 *       node scripts/audit_mobile.js --quiet     # 只打印汇总
 *
 * 两个阶段：
 *   ① 静态检查（node 直读 HTML）：JS 语法 / 标签配对 / id 引用 / onclick 定义
 *   ② 运行时审核（无头 Chrome 量测）：逐页走一遍，用坐标与样式做量化判定
 *
 * 审核维度（对齐移动端操作体验）：
 *   HIT_SMALL      触控热区 min(w,h) < 44px（iOS HIG 下限）
 *   HIT_OVERLAP    两个可点元素重叠 → 误触
 *   HIT_CROWD      相邻可点元素垂直间距 < 2px（网格类留 2px 缝即算达标）
 *   H_OVERFLOW     横向溢出（scrollWidth > clientWidth）或元素出框
 *   OFFSCREEN_MAIN 主操作（.btn.primary）不在底部固定区 → 够不着
 *   THUMB_LOW      选项组（.options）落点不在拇指区：中心 < 屏高 55% 或 下沿 < 屏高 75%
 *   THUMB_GAP      选项组没贴底：下沿到选项区可用空间底部还空着 > 40px（居中/顶对齐）
 *   GAP_DEAD       题干区与选项组之间出现断层死白 > 48px（剩余高度没被题干区认领）
 *   OPTION_OFFSCREEN 选项组下沿超出视口
 *   TOAST_COVER    toast 落点被底部固定区遮住
 *   SCROLL_CUT     滚动到底仍有内容被裁
 *   FONT_TINY      字号 < 11px
 *   FONT_SMALL     字号 11~11.9px
 *   CONTRAST_LOW   对比度 < 3.0（P1）/ < 4.5（P2，正文 AA 线）
 *   NO_PRESS_STATE 可点类缺按压反馈态
 *   SAFE_AREA      底部固定区未避让 iOS Home 条
 *   REACH_UNREACH  页面从引导页出发不可达
 *   RAPID_FIRE     快速连点导致状态跳变（丢词 / 重复打卡）
 *   AUDIT_EMPTY    审计目标为空（"没发现问题"和"没看到东西"要区分开）
 *
 * ⚠️ 结论只在「审计目标非空」的前提下有效，脚本对每页都会断言可点元素数 > 0。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const PROTOTYPE = path.join(ROOT, 'design', 'prototype.html')
const OUT_JSON = path.join(ROOT, 'build', 'audit-mobile.json')
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const QUIET = process.argv.includes('--quiet')

const C = {
  ok: (s) => '\u001b[32m' + s + '\u001b[0m',
  warn: (s) => '\u001b[33m' + s + '\u001b[0m',
  bad: (s) => '\u001b[31m' + s + '\u001b[0m',
  dim: (s) => '\u001b[2m' + s + '\u001b[0m',
  b: (s) => '\u001b[1m' + s + '\u001b[0m'
}

/* ================================================================== */
/* ① 静态检查                                                          */
/* ================================================================== */
function staticChecks(html) {
  const checks = []
  const record = (name, ok, detail) => checks.push({ name, ok, detail })

  const scripts = []
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html))) scripts.push(m[1])

  // JS 语法
  let syntaxOk = true
  let syntaxDetail = scripts.length + ' 段 inline script'
  scripts.forEach((s, i) => {
    try {
      new Function(s)
    } catch (e) {
      syntaxOk = false
      syntaxDetail = '第 ' + (i + 1) + ' 段语法错误：' + e.message
    }
  })
  record('JS 语法', syntaxOk, syntaxDetail)

  // 标签配对（先剥掉 <style> 与 <svg> 内容，避免干扰）
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const pair = {}
  ;['section', 'div', 'view', 'text'].forEach((tag) => {
    const open = (stripped.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) || []).length
    const selfClose = (stripped.match(new RegExp('<' + tag + '[^>]*/>', 'g')) || []).length
    const close = (stripped.match(new RegExp('</' + tag + '>', 'g')) || []).length
    pair[tag] = { open: open - selfClose, close }
  })
  const badPair = Object.keys(pair).filter((t) => pair[t].open !== pair[t].close)
  record(
    '标签配对',
    badPair.length === 0,
    badPair.length
      ? badPair.map((t) => t + ' ' + pair[t].open + '/' + pair[t].close).join(' ')
      : Object.keys(pair)
          .map((t) => t + ' ' + pair[t].open + '/' + pair[t].close)
          .join(' · ')
  )

  // getElementById 引用的 id 是否存在
  const ids = new Set()
  let im
  const reId = /\bid="([^"]+)"/g
  while ((im = reId.exec(html))) ids.add(im[1])
  const refs = new Set()
  const reRef = /getElementById\(\s*'([^']+)'\s*\)/g
  while ((im = reRef.exec(html))) refs.add(im[1])
  const missIds = [...refs].filter((r) => !ids.has(r))
  record('id 引用', missIds.length === 0, missIds.length ? '缺：' + missIds.join(', ') : refs.size + ' 个引用全部存在')

  // inline onclick 调用的函数是否有定义
  const called = new Set()
  const reCall = /onclick=(?:\\?")?([A-Za-z_$][\w$]*)\s*\(/g
  while ((im = reCall.exec(html))) called.add(im[1])
  const defined = new Set()
  const reDef = /function\s+([A-Za-z_$][\w$]*)\s*\(/g
  while ((im = reDef.exec(html))) defined.add(im[1])
  const missFn = [...called].filter((f) => !defined.has(f))
  record('onclick 定义', missFn.length === 0, missFn.length ? '未定义：' + missFn.join(', ') : called.size + ' 个函数全部有定义')

  // 按压反馈态（伪类无法用 JS 运行时读，静态查 CSS）
  const pressClasses = ['.btn', '.option', '.tab', '.ob-option', '.pf-goal', '.wb-item', '.cal-cell']
  const missingPress = pressClasses.filter(
    (cls) => !new RegExp(cls.replace('.', '\\.') + ':active').test(html)
  )
  record(
    '按压反馈态',
    missingPress.length === 0,
    missingPress.length ? '缺 :active → ' + missingPress.join(' ') : '主要可点类均有 :active'
  )

  return checks
}

/* ================================================================== */
/* ② 运行时审核 harness（注入到页面里执行，浏览器环境）                 */
/* ================================================================== */
const HARNESS = String.raw`
;(function () {
  var MIN_HIT = 44
  var RESULT = { pages: [], global: [], meta: {} }
  var phone = document.getElementById('phone')
  // 由 node 侧静态调用图注入：函数名 → 它最终能到达的页面 / 返回箭头落点
  var FN_TARGETS = __FN_TARGETS__
  var BACK_EDGES = __BACK_EDGES__
  // node 侧扫到的「样式表里写了 env(safe-area-inset-bottom)」——桌面浏览器 env 恒为 0，
  // 计算值区分不出「写了 env」和「只写了固定值」，必须靠这个布尔值补判
  var SAFE_ENV = __SAFE_ENV__

  function push(list, level, type, msg, extra) {
    list.push({ level: level, type: type, msg: msg, extra: extra == null ? null : extra })
  }
  function visible(el) {
    var n = el
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false
      n = n.parentElement
    }
    return true
  }
  function onScreen(el) {
    var r = el.getBoundingClientRect()
    return r.width > 4 && r.height > 4
  }
  function isAncestor(a, b) {
    var n = b.parentElement
    while (n) { if (n === a) return true; n = n.parentElement }
    return false
  }
  function px(n) { return Math.round(n) }
  function box(r) { return px(r.width) + 'x' + px(r.height) }

  // ---------- 颜色 / 对比度 ----------
  function srgb(c) { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  function lum(c) { return 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]) }
  function ratio(a, b) {
    var l1 = lum(a), l2 = lum(b)
    if (l1 < l2) { var t = l1; l1 = l2; l2 = t }
    return (l1 + 0.05) / (l2 + 0.05)
  }
  function parseColor(s) {
    var m = /rgba?\(([^)]+)\)/.exec(s || '')
    if (!m) return null
    var p = m[1].split(',').map(function (x) { return parseFloat(x) })
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 }
  }
  function gradColors(s) {
    var out = [], re = /rgba?\([^)]+\)/g, mm
    while ((mm = re.exec(s))) { var c = parseColor(mm[0]); if (c && c.a > 0.5) out.push(c.rgb) }
    return out
  }
  function hexOf(c) {
    return '#' + c.map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2) }).join('')
  }
  // 向上找背景：最近的不透明实色；沿途若遇渐变则把渐变各色一并作为候选（取最差对比）
  function bgCandidates(el) {
    var n = el, solid = null, grads = []
    while (n && n.nodeType === 1) {
      var cs = getComputedStyle(n)
      if (!grads.length && cs.backgroundImage && cs.backgroundImage !== 'none') {
        var g = gradColors(cs.backgroundImage)
        if (g.length) grads = g
      }
      var c = parseColor(cs.backgroundColor)
      if (c && c.a > 0.95) { solid = c.rgb; break }
      n = n.parentElement
    }
    if (grads.length) return { grad: true, colors: solid ? grads.concat([solid]) : grads }
    return { grad: false, colors: solid ? [solid] : [[255, 255, 255]] }
  }
  function textEls(root) {
    var out = [], all = root.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      var el = all[i], tag = el.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'PRE') continue
      if (!visible(el)) continue
      var t = ''
      for (var j = 0; j < el.childNodes.length; j++) {
        if (el.childNodes[j].nodeType === 3) t += el.childNodes[j].textContent
      }
      t = t.replace(/\s+/g, ' ').trim()
      if (t) out.push({ el: el, text: t })
    }
    return out
  }

  // ---------- 逐页采集 ----------
  // ⚠️ 页面里的 TITLES / PAGES / state / learnIdx 是 const/let，不在 window 上，
  //    但同一 realm 的后续 script 可以直接按标识符访问 → 必须裸用，不能写 window.xxx
  var PAGE_LABEL = {}
  ;(PAGES || []).forEach(function (p) { PAGE_LABEL[p[0]] = p[1] })
  var SCREENS = Object.keys(TITLES || {})

  function auditPage(id) {
    var rec = { id: id, label: PAGE_LABEL[id] || id, hitCount: 0, issues: [] }
    openPage(id)
    var screen = document.getElementById(id)
    if (!screen) { push(rec.issues, 'P0', 'AUDIT_EMPTY', '页面不存在'); return rec }

    var pr = phone.getBoundingClientRect()
    var scroll = screen.querySelector('.scroll')
    var bottom = screen.querySelector('.bottom')
    if (scroll) scroll.scrollTop = 0

    // ① 触控热区
    var hits = [].slice.call(screen.querySelectorAll('[data-act]')).filter(onScreen)
    rec.hitCount = hits.length
    if (!hits.length) push(rec.issues, 'P0', 'AUDIT_EMPTY', '该页未采集到任何可点元素，审计结果无效')

    hits.forEach(function (el) {
      var r = el.getBoundingClientRect()
      var w = px(r.width), h = px(r.height)
      if (Math.min(w, h) < MIN_HIT) {
        push(rec.issues, 'P1', 'HIT_SMALL', (el.className || el.tagName) + ' 热区 ' + w + 'x' + h + '（下限 ' + MIN_HIT + '）', { w: w, h: h })
      }
    })

    // ② 重叠 → 误触
    for (var i = 0; i < hits.length; i++) {
      for (var j = i + 1; j < hits.length; j++) {
        var a = hits[i], b = hits[j]
        if (isAncestor(a, b) || isAncestor(b, a)) continue
        var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        var ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
        var oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
        if (ox > 2 && oy > 2) {
          push(rec.issues, 'P0', 'HIT_OVERLAP',
            (a.className || a.tagName) + ' 与 ' + (b.className || b.tagName) + ' 重叠 ' + px(ox) + 'x' + px(oy) + 'px')
        }
      }
    }

    // ③ 相邻可点元素垂直间距 < 2px（口径：相邻热区之间至少要有一条可见缝隙。
    //    原定 8px 对日历这类网格过严 —— 网格项留 2px 缝已足够区分，且真实误触风险低于并排按钮）
    var sorted = hits.slice().sort(function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top })
    for (var k = 1; k < sorted.length; k++) {
      var prev = sorted[k - 1].getBoundingClientRect(), cur = sorted[k].getBoundingClientRect()
      var gap = cur.top - prev.bottom
      if (gap > -1 && gap < 2 && !isAncestor(sorted[k - 1], sorted[k]) && !isAncestor(sorted[k], sorted[k - 1])) {
        push(rec.issues, 'P2', 'HIT_CROWD',
          (sorted[k - 1].className || 'el') + ' 与 ' + (sorted[k].className || 'el') + ' 间距仅 ' + px(gap) + 'px')
      }
    }

    // ④ 横向溢出
    if (scroll && scroll.scrollWidth > scroll.clientWidth + 1) {
      push(rec.issues, 'P0', 'H_OVERFLOW', '内容横向溢出 ' + (scroll.scrollWidth - scroll.clientWidth) + 'px（移动端最易见的破版）')
    }
    ;[].slice.call(screen.querySelectorAll('*')).forEach(function (el) {
      if (!visible(el) || el.classList.contains('heat') || el.classList.contains('toast')) return
      var r = el.getBoundingClientRect()
      if (r.width < 2) return
      if (r.right > pr.right + 1) push(rec.issues, 'P0', 'H_OVERFLOW', (el.className || el.tagName) + ' 右溢出 ' + px(r.right - pr.right) + 'px')
    })

    // ⑤ 主操作是否在拇指区（底部固定区）
    var primaries = [].slice.call(screen.querySelectorAll('.btn.primary')).filter(visible)
    primaries.forEach(function (b) {
      var inBottom = bottom && (bottom.contains(b) || b.closest('.bottom'))
      var r = b.getBoundingClientRect()
      if (!inBottom) {
        var relTop = (r.top - pr.top) / pr.height
        push(rec.issues, 'P1', 'OFFSCREEN_MAIN',
          '主操作「' + b.textContent.trim().slice(0, 10) + '」在内容流内（屏高 ' + Math.round(relTop * 100) + '% 处）→ 单手拇指够不着')
      } else {
        if (px(r.height) < 44) push(rec.issues, 'P1', 'HIT_SMALL', '主操作高度 ' + px(r.height) + 'px < 44')
      }
    })

    // ⑥ toast 是否被底部固定区遮住（真机视口 = 屏幕，按数值推断）
    // ⚠️ 必须走真实路径：原型的 toast 位置在 toast() 里按「当前页底栏高 + 16」动态算，
    //    直接读 CSS 静态值等于没测（实测因此把已修好的 8 页全报成 TOAST_COVER）
    var toastEl = document.getElementById('toast')
    if (typeof toast === 'function') { try { toast('审核') } catch (e) {} }
    var toastOffset = parseFloat(getComputedStyle(toastEl).bottom)
    if (toastEl) toastEl.classList.remove('show')
    if (bottom) {
      var bh = px(bottom.getBoundingClientRect().height)
      if (toastOffset < bh) {
        push(rec.issues, 'P1', 'TOAST_COVER', 'toast 距屏底 ' + px(toastOffset) + 'px，底部固定区高 ' + bh + 'px → 真机上提示会被按钮盖住', { toastOffset: px(toastOffset), bottomH: bh })
      }
    }

    // ⑦ 安全区避让（iPhone Home 条）
    // 底栏若为 flush 形态，自身 padding 为 0，避让写在里面的 .tabbar 上 → 取两者较大值判定
    if (bottom) {
      var padB = parseFloat(getComputedStyle(bottom).paddingBottom) || 0
      var tbar = bottom.querySelector('.tabbar')
      var padB2 = tbar ? (parseFloat(getComputedStyle(tbar).paddingBottom) || 0) : 0
      var padMax = Math.max(padB, padB2)
      if (padMax < 8 || !SAFE_ENV) {
        push(rec.issues, 'P2', 'SAFE_AREA',
          '底部固定区没避让 Home 条（padding-bottom ' + padMax + 'px，样式表 env()：' + (SAFE_ENV ? '有' : '无') + '）')
      }
    }

    // ⑧ 字号与对比度
    var tiny = 0, small = 0, lowP1 = 0, lowP2 = 0
    textEls(screen).forEach(function (o) {
      var cs = getComputedStyle(o.el)
      var fs = parseFloat(cs.fontSize)
      var fw = parseInt(cs.fontWeight, 10) || 400
      if (fs < 11) { tiny++; push(rec.issues, 'P1', 'FONT_TINY', fs + 'px「' + o.text.slice(0, 12) + '」') }
      // 11px（22rpx）是移动端辅助标签的通行下限（微信原生 tabBar 约 10px），
      // 且这些都不承载关键信息 → 归 INFO 存档，不算缺陷；正文硬线由上面 FONT_TINY 守
      else if (fs < 12) { small++; push(rec.issues, 'INFO', 'FONT_SMALL', fs + 'px「' + o.text.slice(0, 12) + '」') }

      var fg = parseColor(cs.color)
      if (!fg || fg.a < 0.9) return
      var bg = bgCandidates(o.el)
      bg.colors.forEach(function (b) {
        var r = ratio(fg.rgb, b)
        var need = fs >= 24 ? 3 : (fs >= 18.66 && fw >= 700) ? 3 : 4.5
        if (r < 3 - 0.02) {
          lowP1++
          push(rec.issues, 'P1', 'CONTRAST_LOW', hexOf(fg.rgb) + ' on ' + hexOf(b) + ' = ' + r.toFixed(2) + ':1 · ' + fs + 'px「' + o.text.slice(0, 10) + '」')
        } else if (r < need - 0.02) {   // 容忍浮点：4.50 就是及格，不该因 4.4988 报错
          lowP2++
          push(rec.issues, 'P2', 'CONTRAST_LOW', hexOf(fg.rgb) + ' on ' + hexOf(b) + ' = ' + r.toFixed(2) + ':1（AA ' + need + '）· ' + fs + 'px「' + o.text.slice(0, 10) + '」')
        }
      })
    })
    rec.textStats = { tiny: tiny, small: small, lowP1: lowP1, lowP2: lowP2 }

    // ⑨ 滚动到底是否被裁 + 首屏留白
    if (scroll) {
      var last = scroll.lastElementChild
      scroll.scrollTop = scroll.scrollHeight
      if (last) {
        var lr = last.getBoundingClientRect(), sr = scroll.getBoundingClientRect()
        if (lr.bottom > sr.bottom + 1) push(rec.issues, 'P0', 'SCROLL_CUT', '滚动到底仍有 ' + px(lr.bottom - sr.bottom) + 'px 内容被裁')
      }
      scroll.scrollTop = 0
      var contentH = scroll.scrollHeight, viewH = scroll.clientHeight
      rec.fill = { content: contentH, view: viewH, slack: viewH - contentH }
      if (contentH < viewH * 0.8) {
        push(rec.issues, 'P2', 'EMPTY_SPACE', '内容 ' + contentH + 'px / 可视 ' + viewH + 'px → 底部留白 ' + (viewH - contentH) + 'px')
      }
    }

    // ⑩ 选项组落点是否在拇指可达区（练习页）
    // 三条判据（都在「整屏顶对齐」或「按比例居中」的写法下失守）：
    //   · 中心 ≥ 屏高 55% —— 整组落在下半区（实测：新版 61% / 居中 56~58% / 顶对齐 52%）
    //   · 下沿 ≥ 屏高 75% —— 最后一项压进屏幕下四分之一（新版 80% / 居中 76~77% / 顶对齐 71%）
    //   · 下沿空档 ≤ 40px —— 整组是否**贴底**（最锋利的一条，见下）
    // 阈值来历：早期版本（顶对齐 + 小选项 + 无固定题干卡片）实测 49% / 66%，50/70 也拦得住；
    // 但把阈值留在 50/70 时，「flex:0 不撑开 + flex-start」这种写法能拿到 52%/71% 溜过去 ——
    // 所以按现有实测重新定线，三条一起卡。
    // 必要性：选项组压在屏幕中上部时下半区空着 —— 单手（尤其右手持机）够不到。
    // 这不是热区尺寸问题（每项 60px 已 ≥ 44px 下限），热区检查照不到，必须单独看「落点」。
    var optWrap = screen.querySelector('.options')
    if (optWrap) {
      var optEls = [].slice.call(optWrap.querySelectorAll('.option')).filter(visible)
      if (optEls.length) {
        var ors = optEls.map(function (o) { return o.getBoundingClientRect() })
        var oTop = Math.min.apply(null, ors.map(function (r) { return r.top }))
        var oBot = Math.max.apply(null, ors.map(function (r) { return r.bottom }))
        var relMid = ((oTop + oBot) / 2 - pr.top) / pr.height
        var relBot = (oBot - pr.top) / pr.height
        // 下沿空档 = 从选项组下沿到「选项区可用空间的底部」还有什么都没占的高度。
        // 扣掉选项区自身 padding-bottom（那是刻意的下沿留白，不是空档），剩下的就是
        // 被 justify-content 分配到组下方的自由空间：贴底 → ≈0（只有反馈文案那一行），
        // 居中 → 自由空间的一半，顶对齐 → 全部。
        // 实测：贴底 26px / 居中 61~69px / 顶对齐 96px（与留白参数无关，只反映对齐方式）
        var slack = null
        var scrollEl = screen.querySelector('.scroll')
        if (scrollEl) {
          var sr = scrollEl.getBoundingClientRect()
          var scs = getComputedStyle(scrollEl)
          var optsCS = getComputedStyle(optWrap)
          var contentBottom = sr.bottom - parseFloat(scs.paddingBottom || 0)
          slack = contentBottom - oBot - parseFloat(optsCS.paddingBottom || 0)
        }
        rec.options = {
          count: optEls.length,
          relMid: Math.round(relMid * 100),
          relBottom: Math.round(relBot * 100),
          top: px(oTop - pr.top),
          bottom: px(oBot - pr.top),
          viewH: px(pr.height),
          gapBelow: slack == null ? null : px(slack),
          minHit: Math.min.apply(null, ors.map(function (r) { return px(r.height) }))
        }
        if (relMid < 0.55) {
          push(rec.issues, 'P1', 'THUMB_LOW',
            '选项组中心在屏高 ' + Math.round(relMid * 100) + '% 处（< 55%）→ 整组压在屏中部及以上，单手握持时拇指够不到', rec.options)
        }
        if (relBot < 0.75) {
          push(rec.issues, 'P1', 'THUMB_LOW',
            '选项组下沿只到屏高 ' + Math.round(relBot * 100) + '%（< 75%）→ 最后一项离握持位太远', rec.options)
        }
        if (slack != null && slack > 40) {
          push(rec.issues, 'P1', 'THUMB_GAP',
            '选项组下沿还空着 ' + px(slack) + 'px（应 ≤40px，只留反馈文案那一行）→ 整组没有贴底：' +
            '下沿与屏幕底部的距离会随屏高浮动（居中/顶对齐时屏越高越靠上，拇指越够不到）', rec.options)
        }
        if (oBot > pr.bottom + 1) {
          push(rec.issues, 'P1', 'OPTION_OFFSCREEN', '最后一个选项下沿超出视口 ' + px(oBot - pr.bottom) + 'px', rec.options)
        }

        // ④ 题干区与选项组之间不能有「断层」死白。
        // 成因很具体：题干卡只取内容高度、选项区 flex:1 贴底 ⇒ 所有剩余高度都堆在两者之间。
        // 实测：375×720 空 156px、430×932 空 368px —— 屏越大越空，页面像没写完。
        // 正确做法是让**题干区自己吃掉剩余高度**（.q-card flex:1），题答之间只留一个正常间距。
        // 与 THUMB_GAP 互补：那条看「选项组下方」，这条看「题干与选项之间」——
        // 只修一条会把空白从一处挪到另一处（本项目实测过：居中→贴底只是换了个位置堆）。
        var qCard = screen.querySelector('.q-card')
        if (qCard) {
          var deadGap = oTop - qCard.getBoundingClientRect().bottom
          rec.options.gapAbove = px(deadGap)
          if (deadGap > 48) {
            push(rec.issues, 'P1', 'GAP_DEAD',
              '题干区与选项组之间空着 ' + px(deadGap) + 'px（应 ≤48px）→ 剩余高度堆成了断层死白，' +
              '看起来像页面没写完。让题干区 flex:1 吃掉剩余高度即可（空白变成主视觉的呼吸空间）', rec.options)
          }
        }
      }
    }

    return rec
  }

  // ---------- 可达性图（BFS） ----------
  // ⚠️ 只扫内联 onclick 里的字面量 s-xxx 会漏掉包装函数（finishOnboarding / startLearn /
  //    practiceWrong …），曾因此误报 P0「从引导页出发不可达」——实测 8 页全可达。
  //    故 target 解析交给 node 侧静态调用图（FN_TARGETS，见 buildCallGraph）。
  function reachability() {
    var graph = {}
    var fnTargets = (typeof FN_TARGETS !== 'undefined' && FN_TARGETS) || {}
    var backEdges = (typeof BACK_EDGES !== 'undefined' && BACK_EDGES) || {}
    SCREENS.forEach(function (id) {
      openPage(id)
      var targets = {}
      ;[].slice.call(document.querySelectorAll('#' + id + ' [data-act]')).forEach(function (el) {
        var oc = el.getAttribute('onclick') || ''
        var mm = /s-[a-z]+/g, r
        while ((r = mm.exec(oc))) { if (SCREENS.indexOf(r[0]) >= 0) targets[r[0]] = true }
        var fr = /([A-Za-z_$][\w$]*)\s*\(/g, fm
        while ((fm = fr.exec(oc))) {
          var list = fnTargets[fm[1]]
          if (list) list.forEach(function (t) { targets[t] = true })
        }
      })
      if (backEdges[id]) targets[backEdges[id]] = true
      graph[id] = Object.keys(targets)
    })
    var seen = {}, queue = ['s-onboarding'], order = []
    seen['s-onboarding'] = true
    while (queue.length) {
      var cur = queue.shift()
      order.push(cur)
      ;(graph[cur] || []).forEach(function (n) { if (!seen[n]) { seen[n] = true; queue.push(n) } })
    }
    var unreachable = SCREENS.filter(function (id) { return !seen[id] })
    RESULT.meta.graph = graph
    RESULT.meta.reachOrder = order
    return unreachable
  }

  // ---------- 连点行为（防抖） ----------
  function rapidFire() {
    var out = []
    // learn：连点两次「下一个」是否跳词
    openPage('s-learn')
    var before = LEARN_WORDS[learnIdx].word
    learnNext(); learnNext()
    var after = LEARN_WORDS[learnIdx].word
    if (learnIdx > 1) {
      out.push({ level: 'P2', type: 'RAPID_FIRE', msg: '学习页连点两次「下一个」：' + before + ' → ' + after + '（跳过了 1 个词）' })
    }
    // checkin：连点两次打卡是否重复累加
    openPage('s-checkin')
    var s0 = state.streak
    doCheckin(); var s1 = state.streak; doCheckin()
    var s2 = state.streak
    if (s2 - s0 > 1) {
      out.push({ level: 'P2', type: 'RAPID_FIRE', msg: '连点两次打卡：连续天数 ' + s0 + ' → ' + s1 + ' → ' + s2 + '（重复累加，真机需按钮态保护）' })
    }
    resetAll()
    return out
  }

  // ---------- 主流程 ----------
  try {
    SCREENS.forEach(function (id) { RESULT.pages.push(auditPage(id)) })
    var unreachable = reachability()
    if (unreachable.length) {
      push(RESULT.global, 'P0', 'REACH_UNREACH', '从引导页出发不可达：' + unreachable.join(', '))
    }
    RESULT.meta.unreachable = unreachable
    RESULT.meta.rapidFire = rapidFire()
    RESULT.meta.rapidFire.forEach(function (i) { RESULT.global.push(i) })
    RESULT.meta.ok = true
  } catch (e) {
    RESULT.meta.ok = false
    RESULT.meta.error = e.message + ' @ ' + (e.stack || '').split('\n')[1]
  }
  window.__AUDIT__ = RESULT
  var pre = document.createElement('pre')
  pre.id = '__audit__'
  pre.textContent = JSON.stringify(RESULT).replace(/</g, '\\u003c')
  document.body.appendChild(pre)
})();
`

/* ================================================================== */
/* 静态调用图：函数名 → 它能到达的页面（供 harness 做可达性判定）        */
/* 必要性：可达性只认内联 onclick 的字面量会漏掉包装函数，造成假 P0       */
/* ================================================================== */
function buildCallGraph(html) {
  const scripts = []
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html))) scripts.push(m[1])
  const src = scripts[scripts.length - 1] || ''

  // 页面白名单：函数体里扫 s-xxx 会误命中 'has-back' 这类类名字符串，必须收紧
  const screenIds = [...html.matchAll(/<section[^>]*\bid="(s-[a-z]+)"/g)].map((x) => x[1])
  const isScreen = (t) => screenIds.indexOf(t) >= 0

  // 用花括号配平切出每个 function 的函数体
  const bodies = {}
  const reDef = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g
  while ((m = reDef.exec(src))) {
    const name = m[1]
    let i = m.index + m[0].length
    let depth = 1
    const start = i
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    bodies[name] = src.slice(start, i - 1)
  }

  // 传递闭包（深度 3，防环）
  const FN = {}
  const targetsOf = (name, depth, stack) => {
    if (stack.indexOf(name) >= 0) return new Set()
    const body = bodies[name] || ''
    const out = new Set((body.match(/s-[a-z]+/g) || []).filter(isScreen))
    if (depth > 0) {
      const next = new Set([...body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((c) => c[1]))
      next.forEach((f) => {
        if (f === name || !bodies[f]) return
        targetsOf(f, depth - 1, stack.concat(name)).forEach((t) => out.add(t))
      })
    }
    return out
  }
  Object.keys(bodies).forEach((n) => { FN[n] = [...targetsOf(n, 3, [])] })

  // 返回箭头落点（navBack 读 BACK[current]，是动态映射，需单独抽出）
  const BACK = {}
  const bm = /(?:const|let|var)\s+BACK\s*=\s*\{([^}]*)\}/.exec(src)
  if (bm) {
    let kv
    const reKV = /'([^']+)'\s*:\s*'([^']+)'/g
    while ((kv = reKV.exec(bm[1]))) { if (isScreen(kv[1]) && isScreen(kv[2])) BACK[kv[1]] = kv[2] }
  }
  return { FN, BACK }
}

/* ================================================================== */
/* 无头 Chrome 执行                                                     */
/* ================================================================== */
function runHeadless(html) {
  const stamp = Date.now()
  const dir = '/tmp/cr_audit_' + stamp
  const page = '/tmp/ielts_audit_page.html'
  const { FN, BACK } = buildCallGraph(html)
  const safeEnvDeclared = /env\(\s*safe-area-inset-bottom/.test(html)
  const harness = HARNESS
    .replace('__FN_TARGETS__', JSON.stringify(FN))
    .replace('__BACK_EDGES__', JSON.stringify(BACK))
    .replace('__SAFE_ENV__', JSON.stringify(safeEnvDeclared))
  const injected = html.replace(
    '</body>',
    '<script>' + harness + '</script>\n</body>'
  )
  fs.writeFileSync(page, injected, 'utf8')

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
      idle = setTimeout(finish, 1200)   // Chrome 写完后不退出 → 静默 1.2s 即收工
    })
    cp.on('close', finish)
    cp.on('error', finish)
    const hard = setTimeout(finish, 40000)
  })
}

function extractResult(dom) {
  const m = /<pre id="__audit__">([\s\S]*?)<\/pre>/.exec(dom)
  if (!m) return null
  const txt = m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
  try {
    return JSON.parse(txt)
  } catch (e) {
    return null
  }
}

/* ================================================================== */
/* 报告                                                                 */
/* ================================================================== */
const ORDER = { P0: 0, P1: 1, P2: 2, INFO: 3 }

function summarize(result) {
  const count = { P0: 0, P1: 0, P2: 0, INFO: 0 }
  const byType = {}
  const bump = (i) => {
    count[i.level] = (count[i.level] || 0) + 1
    byType[i.type] = (byType[i.type] || 0) + 1
  }
  result.pages.forEach((p) => p.issues.forEach(bump))
  result.global.forEach(bump)
  return { count, byType }
}

;(async () => {
  const html = fs.readFileSync(PROTOTYPE, 'utf8')

  console.log(C.b('\n=== 移动端体验审核 · design/prototype.html ===\n'))

  // ① 静态
  console.log(C.b('① 静态检查'))
  const statics = staticChecks(html)
  statics.forEach((c) => {
    console.log('  ' + (c.ok ? C.ok('✓') : C.bad('✗')) + ' ' + c.name.padEnd(14) + C.dim(c.detail))
  })

  // harness 自身语法校验（字符串里的错误不会 throw 到外面，必须显式 check）
  try {
    new Function(
      HARNESS
        .replace('__FN_TARGETS__', '{}')
        .replace('__BACK_EDGES__', '{}')
        .replace('__SAFE_ENV__', 'true')
    )
  } catch (e) {
    console.log(C.bad('\n✗ 审核 harness 语法错误：' + e.message))
    process.exit(2)
  }

  // ② 运行时
  console.log(C.b('\n② 运行时审核（375x720 真机框，逐页量测）'))
  const dom = await runHeadless(html)
  const result = extractResult(dom)
  if (!result) {
    console.log(C.bad('  ✗ 未取到审核结果（Chrome 未跑通或 harness 未执行）'))
    console.log(C.dim('    DOM 长度 ' + dom.length + '，含 __audit__：' + /__audit__/.test(dom)))
    process.exit(2)
  }
  if (!result.meta.ok) {
    console.log(C.bad('  ✗ harness 执行中断：' + result.meta.error))
    process.exit(2)
  }

  result.pages.forEach((p) => {
    const s = summarize({ pages: [p], global: [] })
    const tag =
      s.count.P0 || s.count.P1
        ? C.bad(s.count.P0 + ' 阻断 / ' + s.count.P1 + ' 手感')
        : s.count.P2
          ? C.warn(s.count.P2 + ' 观感')
          : C.ok('达标' + (s.count.INFO ? '（' + s.count.INFO + ' 条提示）' : ''))
    console.log('\n  ' + C.b(p.label.padEnd(8)) + C.dim('可点 ' + p.hitCount) + '   ' + tag)
    // INFO（11px 辅助标签之类）只计数不逐条刷屏
    const sorted = p.issues.slice().sort((a, b) => ORDER[a.level] - ORDER[b.level])
    const real = sorted.filter((i) => i.level !== 'INFO')
    const infos = sorted.length - real.length
    const shown = QUIET ? real.slice(0, 3) : real
    shown.forEach((i) => {
      const lv = i.level === 'P0' ? C.bad('P0') : i.level === 'P1' ? C.warn('P1') : C.dim('P2')
      console.log('    ' + lv + ' ' + C.dim(i.type.padEnd(14)) + ' ' + i.msg)
    })
    if (real.length > shown.length) console.log(C.dim('    … 另有 ' + (real.length - shown.length) + ' 条'))
    if (infos) console.log(C.dim('    · ' + infos + ' 条 INFO（字号提示级，明细见 build/audit-mobile.json）'))
  })

  const gReal = result.global.filter((i) => i.level !== 'INFO')
  if (gReal.length) {
    console.log('\n  ' + C.b('全局'))
    gReal
      .slice()
      .sort((a, b) => ORDER[a.level] - ORDER[b.level])
      .forEach((i) => {
        const lv = i.level === 'P0' ? C.bad('P0') : i.level === 'P1' ? C.warn('P1') : C.dim('P2')
        console.log('    ' + lv + ' ' + C.dim(i.type.padEnd(14)) + ' ' + i.msg)
      })
  }

  const { count, byType } = summarize(result)
  console.log('\n' + C.b('③ 汇总'))
  console.log('  ' + C.dim('可达路径：' + (result.meta.reachOrder || []).map((s) => s.replace('s-', '')).join(' → ')))
  console.log(
    '  ' +
      (count.P0 ? C.bad('P0 ' + count.P0) : C.ok('P0 0')) +
      ' · ' +
      (count.P1 ? C.warn('P1 ' + count.P1) : C.ok('P1 0')) +
      ' · ' +
      (count.P2 ? C.warn('P2 ' + count.P2) : C.ok('P2 0')) +
      ' · ' +
      C.dim('INFO ' + count.INFO)
  )
  const types = Object.keys(byType).sort((a, b) => byType[b] - byType[a])
  console.log('  ' + C.dim(types.map((t) => t + ' ' + byType[t]).join(' · ')))

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, JSON.stringify({ statics, ...result }, null, 2), 'utf8')
  console.log('\n  ' + C.dim('明细已写入 ' + path.relative(ROOT, OUT_JSON)))

  const staticFail = statics.filter((c) => !c.ok).length
  process.exit(count.P0 || staticFail ? 1 : 0)
})()
