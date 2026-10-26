'use strict';
/**
 * 打卡页 loading 去重契约自测（node 直跑，零依赖，不需要小程序运行时）
 *
 *   node scripts/test_checkin.js
 *
 * 背景（2026-10-26 用户要求）：小程序里全局 loading（api 层 wx.showLoading）与
 * 页面级「加载中」提示有重复——checkin 页两者同时显示、文案还都是「打卡中」。
 * 处置：保留全局 loading，删掉 checkin 的页面级提示。本测试把两条契约钉住：
 *
 *   ① finishCheckin 必须走全局 loading（loadingText '打卡中'）且 show/hide 成对
 *      —— 页面级提示删了，全局这个就是唯一提示，谁把它改成静默调用，
 *         打卡过程将没有任何反馈（比重复提示更糟）；
 *   ② checkin.wxml 不得重新出现页面级 .loading —— 防重复提示回归。
 *
 * 共享骨架（wx 桩 / 断言 / 页面捕获）见 scripts/_harness.js。
 */
const fs = require('fs')
const path = require('path')
const { ROOT, drain, tester, stub, installWx, loadPage } = require('./_harness')

// 全局 loading 流水（api 层 wx.showLoading / hideLoading）与 toast 流水
const loadingCalls = []
const toastCalls = []
// 云函数桩：每个用例开测前替换实现
let fnImpl = async () => ({ result: { code: 0, data: {} } })
const { navs } = installWx({
  showLoading(o) {
    loadingCalls.push((o && o.title) || '')
  },
  hideLoading() {
    loadingCalls.push('hide')
  },
  showToast(o) {
    toastCalls.push((o && o.title) || '')
  },
  cloud: {
    callFunction: async () => fnImpl()
  }
})
stub('miniprogram/utils/share.js', { toFriend: (o) => o || {} })

// 用**真实** api.js（USE_MOCK=false）：call() 会真的走 wx.showLoading，
// 这样才能验到「全局 loading 覆盖打卡请求」这条契约
const page = loadPage('miniprogram/pages/checkin/checkin.js')

const { t, done } = tester()

/** 重置页面 data 与流水，跑一次 onLoad 并等 Promise 落地 */
async function runOnLoad(impl) {
  fnImpl = impl
  loadingCalls.length = 0
  toastCalls.length = 0
  page.data.loading = true
  page.data.streak = 0
  page.data.learnedCount = 0
  page.data.totalLearned = 0
  page.data.already = false
  await page.onLoad()
  await drain()
}

const OK = {
  streak: 3,
  learnedCount: 5,
  totalLearned: 42,
  already: false
}

async function main() {
  /* ---------- ① 成功路径：全局 loading 覆盖 + 成对 hide ---------- */
  await runOnLoad(async () => ({ result: { code: 0, data: OK } }))
  t('成功后 loading 落下（底栏解除门控，不卡死）', page.data.loading === false)
  t('打卡数据落值', page.data.streak === 3 && page.data.learnedCount === 5 && page.data.totalLearned === 42)
  t('全局 loading 覆盖打卡请求（showLoading「打卡中」）', loadingCalls[0] === '打卡中')
  t('全局 loading 成对 hide', loadingCalls.indexOf('hide') > 0)

  /* ---------- ② 云端返回错误码：不卡死 + 有 toast ---------- */
  await runOnLoad(async () => ({ result: { code: 500, message: 'boom' } }))
  t('业务失败也不卡死（loading 落下）', page.data.loading === false)
  t('业务失败有 toast 提示', toastCalls.length === 1)

  /* ---------- ③ 网络异常：不卡死 ---------- */
  await runOnLoad(async () => {
    throw new Error('net down')
  })
  t('网络异常不卡死（loading 落下）', page.data.loading === false)
  t('网络异常有 toast 提示', toastCalls.length === 1)

  /* ---------- ④ 契约②：wxml 不得回归页面级 .loading ---------- */
  // 源码面断言先剥注释——文件里有解释性注释，不剥会误判
  const wxml = fs
    .readFileSync(path.join(ROOT, 'miniprogram/pages/checkin/checkin.wxml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
  t('checkin.wxml 无页面级 .loading（全局已覆盖，防重复提示回归）', !/class="loading"/.test(wxml))
  // 负向验证：证明这条断言有牙——旧版页面级 markup 必须能被抓到
  t(
    '  ↳ 负向：旧版页面级 markup 会被抓到',
    /class="loading"/.test('<view wx:if="{{loading}}" class="loading">打卡中</view>')
  )
  // 顺带确认结构没被改坏：内容区与底栏都仍由 !loading 门控
  t('内容区仍由 !loading 门控', /wx:if="\{\{!loading\}\}"/.test(wxml))
  t('底栏仍由 !loading 门控（内容区 + 底栏共两处）', (wxml.match(/wx:if="\{\{!loading\}\}"/g) || []).length === 2)

  /* ---------- ⑤ 底栏行为没动 ---------- */
  page.goHome()
  t('goHome 走 switchTab 回首页', navs[navs.length - 1] === 'switchTab:/pages/index/index')

  done()
}

main()
