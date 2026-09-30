'use strict'
/**
 * miniprogram + cloudfunctions 结构性自查（零依赖，node 直跑）
 *
 *   node scripts/check_miniprogram.js
 *
 * 为什么需要它：scripts/audit_mobile.js 与 scripts/test_prototype.js 的检测目标
 * 写死是 design/prototype.html，**不读 miniprogram/**，对小程序改动零验证力。
 * 本脚本是「改完能不能跑起来」这一层的检查，补上那两块空白。
 *
 * ① app.json tabBar 配置与图标文件是否齐全
 * ② wxml 用到的 class 是否都有定义（app.wxss 或本页 wxss）
 * ③ 有 .bottombar 的页面，.page 是否加了 padding-bottom（本工程最高频的错）
 * ④ wxml 标签开闭配对
 * ⑤ 云函数三件套 index.js / config.json / package.json(含 wx-server-sdk)
 *    —— 漏 package.json 会导致云端报 `Cannot find module 'wx-server-sdk'`（已踩过）
 * ⑥ config.FN 里声明的函数名，cloudfunctions/ 下是否真有对应目录
 *    —— 「config.FN 里有名字 ≠ 能调」，这条能自动抓出来
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const CF = path.join(ROOT, 'cloudfunctions')

const err = []
const warn = []

/* ---------- ① tabBar ---------- */
const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'))
const tb = app.tabBar
if (!tb) err.push('app.json 没有 tabBar')
else {
  console.log('tabBar: ' + tb.list.length + ' 项')
  tb.list.forEach((it) => {
    ;[it.iconPath, it.selectedIconPath].forEach((p) => {
      if (!fs.existsSync(path.join(MP, p))) err.push('缺图标文件 ' + p)
    })
    if (!app.pages.includes(it.pagePath)) err.push('tabBar.pagePath 不在 pages: ' + it.pagePath)
    console.log('  ' + it.text + '  ' + it.pagePath + '  ' + it.iconPath + ' / ' + it.selectedIconPath)
  })
}

/* ---------- ②③④ 逐页检查 ---------- */
const appwxss = fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8')
const globalClasses = new Set([...appwxss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))
const pages = fs.readdirSync(path.join(MP, 'pages'))

const readPage = (pg) => {
  const dir = path.join(MP, 'pages', pg)
  const wxmlPath = path.join(dir, pg + '.wxml')
  const wxssPath = path.join(dir, pg + '.wxss')
  return {
    wxml: fs.existsSync(wxmlPath) ? fs.readFileSync(wxmlPath, 'utf8') : null,
    wxss: fs.existsSync(wxssPath) ? fs.readFileSync(wxssPath, 'utf8') : ''
  }
}

// ② 类名
pages.forEach((pg) => {
  const { wxml, wxss } = readPage(pg)
  if (wxml === null) return
  const local = new Set([...wxss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))
  const used = new Set()
  ;[...wxml.matchAll(/class="([^"]*)"/g)].forEach((m) => {
    m[1]
      .replace(/\{\{[^}]*\}\}/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((c) => used.add(c))
  })
  // 三元表达式里的字符串类名（如 {{isLast ? 'done' : ''}}）
  ;[...wxml.matchAll(/'\s*([\w-]+)\s*'\s*:/g)].forEach((m) => used.add(m[1]))
  ;[...wxml.matchAll(/:\s*'\s*([\w-]+)\s*'/g)].forEach((m) => used.add(m[1]))
  const missing = [...used].filter((c) => !local.has(c) && !globalClasses.has(c))
  if (missing.length) warn.push(pg + ' 用到的类没有定义: ' + missing.join(', '))
})

// ③ 固定底栏三件套
const barRule = appwxss.match(/\.bottombar\s*\{[^}]*\}/)
const barHasEnv = !!barRule && /env\(safe-area-inset-bottom\)/.test(barRule[0])
console.log('\n.bottombar 自带 env(safe-area-inset-bottom): ' + barHasEnv)
if (!barHasEnv) err.push('.bottombar 缺少 env(safe-area-inset-bottom) 避让')

pages.forEach((pg) => {
  const { wxml, wxss } = readPage(pg)
  if (wxml === null) return
  if (!/class="bottombar"/.test(wxml)) return
  const hasPad = /\.page(?:[.\w-]*)\s*\{[^}]*padding-bottom/.test(wxss)
  console.log('  底栏页 ' + pg + '  .page padding-bottom: ' + (hasPad ? '✓' : '✗ 缺失'))
  if (!hasPad) err.push(pg + ' 有 .bottombar 但 .page 没加 padding-bottom（最后一块内容会被永久遮住）')
})

// ④ 标签配对
pages.forEach((pg) => {
  const { wxml } = readPage(pg)
  if (wxml === null) return
  const s = wxml.replace(/<!--[\s\S]*?-->/g, '')
  ;['view', 'block', 'text', 'button'].forEach((t) => {
    const open = (s.match(new RegExp('<' + t + '[\\s>]', 'g')) || []).length
    const self = (s.match(new RegExp('<' + t + '[^>]*/>', 'g')) || []).length
    const close = (s.match(new RegExp('</' + t + '>', 'g')) || []).length
    if (open - self !== close) {
      err.push(pg + ' <' + t + '> 开闭不配对: 开 ' + (open - self) + ' / 闭 ' + close)
    }
  })
})

/* ---------- ⑤ 云函数三件套 ---------- */
const fnDirs = fs
  .readdirSync(CF)
  .filter((d) => fs.statSync(path.join(CF, d)).isDirectory())
  .sort()
console.log('\n云函数: ' + fnDirs.length + ' 个')
fnDirs.forEach((d) => {
  const p = path.join(CF, d)
  const has = (f) => fs.existsSync(path.join(p, f))
  const miss = ['index.js', 'config.json', 'package.json'].filter((f) => !has(f))
  if (miss.length) {
    err.push('云函数 ' + d + ' 缺 ' + miss.join(' + ') + '（漏 package.json 会报 Cannot find module \'wx-server-sdk\'）')
    console.log('  ❌ ' + d + '  缺 ' + miss.join(', '))
    return
  }
  let sdk = ''
  try {
    const j = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'))
    sdk = (j.dependencies && j.dependencies['wx-server-sdk']) || ''
  } catch (e) {
    err.push('云函数 ' + d + ' 的 package.json 不是合法 JSON')
  }
  if (!sdk) {
    err.push('云函数 ' + d + ' 的 package.json 未声明 wx-server-sdk 依赖')
    console.log('  ❌ ' + d + '  未声明 wx-server-sdk')
  } else {
    console.log('  ✓ ' + d + '  ' + sdk)
  }
})

/* ---------- ⑥ config.FN ↔ 云函数目录 ---------- */
// 已知「config.FN 里有名字、但刻意不建云函数」的项。新增条目必须写清原因，
// 否则这条检查会常亮红 → 被无视（这正是 audit_mobile.js 失真后失去价值的原因）。
const KNOWN_NOT_IMPLEMENTED = {
  daily_line: 'M12 每日一句走前端静态 utils/quotes.js，未实施云函数（后端单 T2 未做，仅 mock 层占位）'
}

const cfgSrc = fs.readFileSync(path.join(MP, 'config.js'), 'utf8')
const fnBlock = cfgSrc.match(/FN\s*[:=]\s*\{([\s\S]*?)\}/)
if (!fnBlock) {
  warn.push('未能从 config.js 解析出 FN 映射')
} else {
  const names = [...fnBlock[1].matchAll(/:\s*'([a-z_][\w]*)'/g)].map((m) => m[1])
  const missing = names.filter((n) => !fnDirs.includes(n))
  console.log('\nconfig.FN 声明 ' + names.length + ' 个函数名')
  if (missing.length) {
    missing.forEach((n) => {
      if (KNOWN_NOT_IMPLEMENTED[n]) {
        console.log('  ℹ️ ' + n + ' —— 已知未实施：' + KNOWN_NOT_IMPLEMENTED[n])
      } else {
        err.push('config.FN 里的函数在 cloudfunctions/ 下无对应目录: ' + n)
        console.log('  ❌ ' + n + '  cloudfunctions/ 下无此目录')
      }
    })
  }
  if (!missing.filter((n) => !KNOWN_NOT_IMPLEMENTED[n]).length) {
    console.log('  ✅ 除已知未实施项外，全部在 cloudfunctions/ 下有对应目录')
  }
  // 反向提示：有目录但没被前端引用（仅 info，不算错）
  const unused = fnDirs.filter((d) => !names.includes(d))
  if (unused.length) console.log('  ℹ️ 仅本地脚本/管理侧调用（前端未引用）: ' + unused.join(', '))
}

/* ---------- 汇总 ---------- */
console.log('')
if (warn.length) {
  console.log('⚠️ 警告 ' + warn.length + ' 条：')
  warn.forEach((w) => console.log('   ' + w))
} else {
  console.log('✅ 类名全部有定义')
}
if (err.length) {
  console.log('❌ 错误 ' + err.length + ' 条：')
  err.forEach((e) => console.log('   ' + e))
  process.exitCode = 1
} else {
  console.log('✅ 结构性检查通过')
}
