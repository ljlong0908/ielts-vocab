'use strict'
/**
 * 学习页（learn）逻辑自测 —— node 直跑，零依赖，不需要小程序运行时
 *
 *   node scripts/test_learn.js
 *
 * 为什么需要它：learn 页有**三种模式**，词源完全不同，而项目里最贵的坑就在这儿 ——
 *   · round=0 主流程：读 today_flow，next 时写 markLearned
 *   · round>0 加练（M13）：读 plan.extraRounds，markLearned 必须带 round
 *   · review=<id> 错题复习（W2）：词源只来自参数，**绝不能碰当日进度**
 * 加练那次就是「读错词源 / 写错记录」出的问题（首页今日进度虚涨、主流程被顶掉）。
 * 复习模式同理：一旦顺手调了 start_new_words，点一下错题本就会推进当日游标。
 * 这类「不该调什么」的约束，check_miniprogram.js 一条都查不到。
 *
 * 做法：桩掉 wx / api / audio / share + getCurrentPages，用 require.cache 注入，
 *      然后**直跑真实的 pages/learn/learn.js**。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const drain = () => new Promise((r) => setTimeout(r, 0))

/* ---------- 可配置的桩状态 ---------- */
let calls = [] // api / audio 调用流水
let navs = [] // 路由跳转记录
let stackDepth = 2 // getCurrentPages().length：2 = 从错题本 navigateTo 进来
let todayFlowData = { plan: { newWordIds: ['a1', 'a2'] } }

global.getCurrentPages = () => new Array(stackDepth).fill({})

global.wx = {
  navigateBack() {
    navs.push('navigateBack')
  },
  redirectTo({ url }) {
    navs.push(url)
  },
  switchTab({ url }) {
    navs.push('switchTab:' + url)
  },
  getStorage: ({ fail }) => fail && fail(),
  setStorage() {},
  showToast() {
    navs.push('showToast') // learn 页无底栏，但也不该用 toast 做提示；出现即记录
  },
  createInnerAudioContext: () => ({
    stop() {},
    play() {
      calls.push('ctx.play')
    },
    onError() {},
    offEnded() {},
    offError() {}
  })
}

const stub = (rel, exports) => {
  const p = require.resolve(path.join(ROOT, rel))
  require.cache[p] = { id: p, filename: p, loaded: true, exports }
}

stub('miniprogram/utils/api.js', {
  todayFlow: async () => {
    calls.push('todayFlow')
    return todayFlowData
  },
  startNewWords: async () => {
    calls.push('startNewWords')
    return { newWordIds: ['fallback1'] }
  },
  startExtraRound: async () => {
    calls.push('startExtraRound')
    return { roundId: 9, wordIds: ['fallback9'] }
  },
  wordCard: async (id) => {
    calls.push('wordCard:' + id)
    return { _id: id, word: 'w_' + id, example: null }
  },
  markLearned: async (id, round) => {
    calls.push('markLearned:' + id + ':' + round)
  }
})
stub('miniprogram/utils/audio.js', {
  playWord: (w) => calls.push('playWord:' + w),
  playSentence: () => calls.push('playSentence'),
  stop: () => calls.push('audio.stop')
})
stub('miniprogram/utils/share.js', { toFriend: (o) => o || {} })

let page = null
global.Page = (cfg) => {
  page = cfg
}
require(path.join(ROOT, 'miniprogram/pages/learn/learn.js'))

page.setData = function (o) {
  Object.assign(this.data, o)
}
const initialData = JSON.parse(JSON.stringify(page.data))
const fresh = () => {
  Object.keys(page.data).forEach((k) => delete page.data[k])
  Object.assign(page.data, JSON.parse(JSON.stringify(initialData)))
  delete page.reviewId
  delete page.round
  page.wordIds = []
  calls = []
  navs = []
}
const cards = () => calls.filter((c) => c.startsWith('wordCard:'))
const api = (p) => calls.filter((c) => c.startsWith(p))

let pass = 0
let fail = 0
const t = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  ok ? pass++ : fail++
}

;(async () => {
  /* ---------- 静态面 ---------- */
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/learn/learn.wxml'), 'utf8')
  t('learn 头部有「错题复习」文案', wxml.includes('错题复习'))
  t('底栏按钮文案收敛到 nextLabel（四种模式在一处算）', /\{\{nextLabel\}\}/.test(wxml))

  /* ---------- 模式一：review 错题复习（W2） ---------- */
  fresh()
  await page.onLoad.call(page, { review: 'w4' })
  await drain()
  t('review：只取参数里那一个词', cards().length === 1 && cards()[0] === 'wordCard:w4')
  t('review：不读 today_flow', !calls.includes('todayFlow'))
  t('review：不调 start_new_words（否则会推进当日游标，点一下就污染今日进度）', !calls.includes('startNewWords'))
  t('review：不调 start_extra_round', !calls.includes('startExtraRound'))
  t('review：头部切到「错题复习」', page.data.isReview === true && page.data.isExtra === false)
  t('review：单卡 1/1', page.data.total === 1 && page.data.index === 0 && page.data.isLast === true)
  t('review：底栏按钮为「复习完成」', page.data.nextLabel === '复习完成')
  t('review：进词仍自动播一次发音', api('playWord').length === 1 && calls.includes('playWord:w_w4'))

  // 出口行为
  calls = []
  navs = []
  await page.next.call(page)
  await drain()
  t('review：点「复习完成」返回上一页（错题本）', navs.length === 1 && navs[0] === 'navigateBack')
  t('review：不写 markLearned（复习 ≠ 已掌握，也不该改当日进度）', api('markLearned').length === 0)
  t('review：不跳练习页', !navs.some((u) => String(u).includes('practice')))
  t('review：离开前停播（不把喇叭带回去）', calls.includes('audio.stop'))

  // 连点锁定（M18）
  fresh()
  await page.onLoad.call(page, { review: 'w4' })
  await drain()
  navs = []
  page.next.call(page)
  page.next.call(page)
  await drain()
  t('review：连点「复习完成」只返回一次', navs.length === 1)

  // 无上一页的兜底（被分享 / 冷启直达）
  stackDepth = 1
  fresh()
  await page.onLoad.call(page, { review: 'w7' })
  await drain()
  navs = []
  await page.next.call(page)
  await drain()
  t('review：没有上一页时退回错题本 tab（tab 页只能 switchTab）', navs[0] === 'switchTab:/pages/wrongbook/wrongbook')
  stackDepth = 2

  /* ---------- 模式二：round=0 主流程（不得回归） ---------- */
  todayFlowData = { plan: { newWordIds: ['a1', 'a2'] } }
  fresh()
  await page.onLoad.call(page, {})
  await drain()
  t('主流程：读 today_flow 拿当日新词', calls.includes('todayFlow') && cards()[0] === 'wordCard:a1')
  t('主流程：不误入复习 / 加练模式', page.data.isReview === false && page.data.isExtra === false)
  t('主流程：首词按钮为「下一个」', page.data.nextLabel === '下一个' && page.data.isLast === false)

  calls = []
  navs = []
  await page.next.call(page)
  await drain()
  t('主流程：「下一个」仍写 markLearned（round=0）', calls.includes('markLearned:a1:0'))
  t('主流程：「下一个」不跳页，只翻卡', navs.length === 0 && page.data.index === 1)
  t('主流程：最后一词按钮为「开始练习」', page.data.nextLabel === '开始练习')

  calls = []
  navs = []
  await page.next.call(page)
  await drain()
  t('主流程：最后一词跳练习页（不带 round）', navs[0] === '/pages/practice/practice?phase=practice')

  /* ---------- 模式三：round>0 加练（M13，不得回归） ---------- */
  todayFlowData = { plan: { extraRounds: [{ roundId: 2, wordIds: ['e1', 'e2'] }] } }
  fresh()
  await page.onLoad.call(page, { round: '2' })
  await drain()
  t('加练：词源取 extraRounds 里 roundId=2 的组', cards()[0] === 'wordCard:e1' && calls.includes('todayFlow'))
  t('加练：不调 start_new_words（不碰主流程 newWordIds）', !calls.includes('startNewWords'))
  t('加练：头部为「加练单词」', page.data.isExtra === true && page.data.isReview === false)

  calls = []
  await page.next.call(page)
  await drain()
  t('加练：markLearned 带 round=2（否则会写进主流程进度）', calls.includes('markLearned:e1:2'))
  t('加练：最后一词按钮为「开始加练小测」', page.data.nextLabel === '开始加练小测')

  navs = []
  await page.next.call(page)
  await drain()
  t('加练：最后一词跳练习页并带 round', navs[0] === '/pages/practice/practice?phase=practice&round=2')

  /* ---------- 模式三之二：中途退出再进来，要跳过已学过的词 ---------- */
  // 用户 2026-09-29 拍板：恢复未完成的组时从「下一个没学的词」继续，不从第 1 个重看
  todayFlowData = {
    plan: { extraRounds: [{ roundId: 3, wordIds: ['e1', 'e2', 'e3'], learnedIds: ['e1'] }] }
  }
  fresh()
  await page.onLoad.call(page, { round: '3' })
  await drain()
  t('加练续学：跳过已学过的 e1，直接从 e2 开始', cards()[0] === 'wordCard:e2')
  t('加练续学：不进 start_extra_round（plan 里有该组）', !calls.includes('startExtraRound'))
  t('加练续学：进度只反映剩余词数（3 个里剩 2 个）', page.data.total === 2)
  t('加练续学：分段条也随之只剩 2 段', page.data.segs.length === 2)
  t('加练续学：仍标记为加练模式', page.data.isExtra === true)

  /* ---------- 模式三之三：词都学完了但小测没做 → 直接进小测 ---------- */
  todayFlowData = {
    plan: { extraRounds: [{ roundId: 4, wordIds: ['e1', 'e2'], learnedIds: ['e1', 'e2'], stage: 'learning' }] }
  }
  fresh()
  navs = []
  await page.onLoad.call(page, { round: '4' })
  await drain()
  t('加练续学：词全学完 → 直接跳小测（不显示空列表）',
    navs[0] === '/pages/practice/practice?phase=practice&round=4')
  t('加练续学：全学完时不取任何单词卡', !calls.some((c) => c.startsWith('wordCard:') && !c.includes('empty')))

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
