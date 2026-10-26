'use strict';
/**
 * 全站 loading 去重契约自测（node 直跑，零依赖，不需要小程序运行时）
 *
 *   node scripts/test_loading.js
 *
 * 背景（2026-10-26 用户两轮要求）：全局 loading（api 层 wx.showLoading）与页面级
 * 「加载中」提示重复——不只文案完全一样的（checkin「打卡中」已处理），**字不一样、
 * 语义差不多的也算重复**（如全局「加载中」vs 页面「加载中」/「正在生成学习内容」）。
 * 处置原则：同义提示只保留一个 = 全局 loading。
 *
 * 本测试钉住全站契约：
 *   ① stats() / getProfile() 翻转为全局 loading（show/hide 成对）——
 *     这三个页面（wrongbook/stats/profile）的页面级提示已删，全局是唯一提示；
 *   ② 刻意静默的接口（homeSummary/markLearned/submitAnswer/dismissWrong）
 *     保持静默——它们是后台/乐观路径，弹 mask 会闪，禁止回归；
 *   ③ checkin/wrongbook/stats/profile 的 wxml 不得有页面级 .loading（防回归）；
 *   ④ learn.wxml 的页面级 cardLoading **必须保留**——wordCard 静默且与预取
 *     共用 promise，不能开全局 loading（预取会弹 mask 挡住阅读），删了它就是零提示。
 *
 * 共享骨架（wx 桩 / 断言 / 页面捕获）见 scripts/_harness.js。
 */
const fs = require('fs')
const path = require('path')
const { ROOT, drain, tester, stub, installWx } = require('./_harness')

// 全局 loading 流水（api 层 wx.showLoading / hideLoading）
const loadingCalls = []
let fnImpl = async () => ({ result: { code: 0, data: {} } })
installWx({
  showLoading(o) {
    loadingCalls.push((o && o.title) || '')
  },
  hideLoading() {
    loadingCalls.push('hide')
  },
  showToast() {},
  cloud: {
    callFunction: async () => fnImpl()
  }
})
stub('miniprogram/utils/share.js', { toFriend: (o) => o || {} })

// 用**真实** api.js（USE_MOCK=false）：call() 真的走 wx.showLoading，
// 这样才能验到每个接口的 loading 开关
const api = require(ROOT + '/miniprogram/utils/api.js')

const { t, done } = tester()

/** 跑一次 api 调用，返回本次的 loading 流水 */
async function run(fn) {
  loadingCalls.length = 0
  await fn()
  await drain()
  return loadingCalls.slice()
}

/** 读 wxml 并剥注释（源码面断言先剥注释，防注释里的字样误判） */
const wxmlOf = (page) =>
  fs
    .readFileSync(path.join(ROOT, 'miniprogram/pages', page, page + '.wxml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')

async function main() {
  /* ---------- ① 翻转为全局 loading 的接口 ---------- */
  {
    const c = await run(() => api.stats())
    t('stats() 走全局 loading「加载中」（wrongbook/stats 页唯一提示）', c[0] === '加载中')
    t('  ↳ show/hide 成对', c.indexOf('hide') > 0)
  }
  {
    const c = await run(() => api.getProfile())
    t('getProfile() 走全局 loading「加载中」（profile 页唯一提示）', c[0] === '加载中')
    t('  ↳ show/hide 成对', c.indexOf('hide') > 0)
  }
  {
    const c = await run(() => api.getProfile(10))
    t('getProfile(goal)（设置每日目标）同样有全局 loading', c[0] === '加载中')
  }

  /* ---------- ② 刻意静默的接口保持静默 ---------- */
  const silent = [
    ['homeSummary', () => api.homeSummary()],
    ['markLearned', () => api.markLearned('w1', 0)],
    ['submitAnswer', () => api.submitAnswer({})],
    ['dismissWrong', () => api.dismissWrong('w1')]
  ]
  for (const [name, fn] of silent) {
    const c = await run(fn)
    t(`${name}() 保持静默（后台/乐观路径，禁弹 mask）`, c.length === 0)
  }

  /* ---------- ③ wxml 契约：四页不得有页面级 .loading ---------- */
  for (const p of ['checkin', 'wrongbook', 'stats', 'profile']) {
    t(`${p}.wxml 无页面级 .loading（同义提示只留全局一处）`, !/class="loading"/.test(wxmlOf(p)))
  }
  // 负向验证（做一次即可）：证明这条断言有牙——旧版页面级 markup 必须能被抓到
  t(
    '  ↳ 负向：旧版页面级 markup 会被抓到',
    /class="loading"/.test('<view wx:if="{{loading}}" class="loading">加载中</view>')
  )

  /* ---------- ④ learn 的页面级 cardLoading 必须保留 ---------- */
  t(
    'learn.wxml 仍保留页面级 cardLoading（wordCard 静默 + 预取共用 promise，不能开全局）',
    /class="loading"/.test(wxmlOf('learn'))
  )

  done()
}

main()
