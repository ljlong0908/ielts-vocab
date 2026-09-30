'use strict'
/**
 * 首页加练按钮显隐逻辑自测（node 直跑，零依赖，不需要小程序运行时）
 *
 *   node scripts/test_index.js
 *
 * 为什么需要它：`buildExtra()` 决定「再学一组」按不按得动，是纯分支逻辑，
 * check_miniprogram.js 只审结构、一条都查不到。且这里踩过一个很隐蔽的坑 ——
 *
 *   ❌ 曾经写成 `if (ex.limitReached) return hide`（先判上限就隐藏）。
 *      后果：用户建满 3 组后中途退出，首页按钮**直接消失**，手里那组再也进不去；
 *      而云端 `canStart` 明明是 true（有未完成组）。症状＝
 *      「刚才还能再学一组，现在不行了」，极容易被误判成「后端没部署」。
 *
 * 共享骨架（wx 桩 / 断言 / 页面捕获）见 scripts/_harness.js。
 */
const { ROOT, tester, stub, installWx, loadPage } = require('./_harness')

installWx()
stub('miniprogram/utils/api.js', {
  homeSummary: async () => ({}),
  todayFlow: async () => ({}),
  startExtraRound: async () => ({ roundId: 1, wordIds: [], reused: false, exhausted: false })
})
stub('miniprogram/utils/audio.js', { stop() {}, playWord() {}, playSentence() {} })
stub('miniprogram/utils/share.js', {
  toFriend: (o) => o || {},
  toTimeline: (o) => Object.assign({ title: '雅词本｜一天一句好英文，顺手记住几个核心词' }, o)
})

const page = loadPage('miniprogram/pages/index/index.js')
// 取回桩句柄，供后面替换实现/计数用
const api = require(ROOT + '/miniprogram/utils/api.js')

const { t, done } = tester()

const build = (summary, flow) => page.buildExtra(summary, flow)

const DONE = { todayDone: true, dailyGoal: 5 }
const UNDONE = { todayDone: false, dailyGoal: 5 }

/** 造一个 today_flow 的 extra 块（字段名与云端 today_flow/index.js 对齐） */
const extra = (o) =>
  Object.assign(
    {
      canStart: true,
      exhausted: false,
      limitReached: false,
      pendingRound: null,
      roundsToday: 0,
      extraLearnedToday: 0,
      groupSize: 5
    },
    o
  )

/* ---------- ① 未打卡：本就不该有加练，隐藏是正确的 ---------- */
{
  const r = build(UNDONE, { extra: extra({ canStart: false }) })
  t('未打卡 → 隐藏（D1=A）', r.extraShow === false)
}

/* ---------- ② 旧版云端（无 extra 字段）：乐观显示，绝不静默隐藏 ---------- */
{
  const r = build(DONE, { plan: {} })
  t('云端没返回 extra（旧版）→ 仍乐观显示按钮', r.extraShow === true && r.extraDisabled === false)
  t('  ↳ 组大小退回每日目标', r.extraSize === 5 && r.extraText === '再学一组')
}

/* ---------- ③ 核心回归：有未完成的组 + 已达上限 → 必须能进 ---------- */
{
  const r = build(DONE, {
    extra: extra({ limitReached: true, pendingRound: { roundId: 3 }, roundsToday: 2 })
  })
  t('★ 已达上限但有未完成组 → 按钮必须显示（不能被上限隐藏）', r.extraShow === true)
  t('★ 且必须可点（不能置灰）', r.extraDisabled === false)
  t('  ↳ 文案改为「继续学一组」', r.extraText === '继续学一组')
  t('  ↳ 仍显示本组词数', r.extraSize === 5)
}

/* ---------- ④ 未完成组优先级最高：即使同时报 exhausted 也要能进 ---------- */
{
  const r = build(DONE, {
    extra: extra({ exhausted: true, limitReached: true, pendingRound: { roundId: 2 } })
  })
  t('未完成组优先于「取尽 / 上限」', r.extraShow === true && r.extraDisabled === false)
}

/* ---------- ⑤ 取尽 / 上限（且无未完成组）→ 显示但置灰 + 说明原因 ---------- */
{
  const ex = build(DONE, { extra: extra({ exhausted: true }) })
  t('词库取尽 → 显示但置灰（不静默消失）', ex.extraShow === true && ex.extraDisabled === true)
  t('  ↳ 底栏给出原因', typeof ex.extraTip === 'string' && ex.extraTip.length > 0)

  const lm = build(DONE, { extra: extra({ limitReached: true, roundsToday: 3 }) })
  t('达上限且无未完成组 → 显示但置灰（不静默消失）', lm.extraShow === true && lm.extraDisabled === true)
  t('  ↳ 底栏给出原因', typeof lm.extraTip === 'string' && lm.extraTip.length > 0)
}

/* ---------- ⑥ 正常态：可点、文案与组大小正确 ---------- */
{
  const r = build(DONE, { extra: extra({ roundsToday: 1, groupSize: 8 }) })
  t('正常态 → 可点、文案「再学一组」', r.extraShow === true && r.extraDisabled === false && r.extraText === '再学一组')
  t('  ↳ 组大小取 groupSize', r.extraSize === 8)
}

/* ---------- ⑦ 源码面：那个坑不能回来 ---------- */
{
  const src = require('fs').readFileSync(ROOT + '/miniprogram/pages/index/index.js', 'utf8')
  // ⚠️ 必须**先剥掉注释行**再匹配：函数上方的说明里就写着反例 `if (limitReached) return hide`，
  //    不剥离的话这条断言会自己把自己判红（字符匹配类断言的通病，本项目踩过多次）
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')
  t('源码里不再有「先判 limitReached 就隐藏」', !/limitReached\)\s*return\s+hide/.test(code))
  t('源码里 pendingRound 分支出现在 limitReached 之前',
    code.indexOf('ex.pendingRound') > -1 && code.indexOf('ex.pendingRound') < code.indexOf('ex.limitReached'))
}

/* ---------- ⑧ 朋友圈分享与单页模式降级（scene 1154） ---------- */
{
  // 分享配置
  const tl = page.onShareTimeline()
  t('朋友圈分享：onShareTimeline 有文案（title）', typeof tl.title === 'string' && tl.title.length > 0)
  t('  ↳ 文案不含诱导性表述', !/(分享|点一下|助力|奖励)/.test(tl.title))

  // 单页模式：不跳 onboarding、置 singlePage、load 不打云端接口
  let relaunched = null
  page.data.singlePage = false
  page.data.quote = null
  wx.getLaunchOptionsSync = () => ({ scene: 1154 })
  wx.reLaunch = (o) => { relaunched = o.url }
  page.onLoad()
  t('单页模式（scene 1154）→ 置 singlePage', page.data.singlePage === true)
  t('  ↳ 不 reLaunch 去 onboarding（单页模式跳转会失败）', relaunched === null)

  let cloudCalls = 0
  api.homeSummary = async () => { cloudCalls++; return {} }
  api.todayFlow = async () => { cloudCalls++; return {} }
  // load() 在首个 await 前的分支（quote 置入 / singlePage 早退）是同步执行完的，无需 await
  page.load()
  t('单页模式 load() → 不打云端接口', cloudCalls === 0)
  t('  ↳ 结束 loading（走静态落地视图）', page.data.loading === false && !!page.data.quote)

  // 普通启动 + 未引导 → 照旧 reLaunch onboarding（负向验证：上面 singlePage 路径已验证过反面）
  page.data.singlePage = false
  wx.getLaunchOptionsSync = () => ({ scene: 1001 })
  page.onLoad()
  t('普通启动未引导 → 仍 reLaunch 去 onboarding', relaunched === '/pages/onboarding/onboarding')
  t('普通启动 → 不置 singlePage', page.data.singlePage === false)
}

done()
