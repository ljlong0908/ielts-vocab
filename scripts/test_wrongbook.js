'use strict'
/**
 * 错题本页面逻辑自测（node 直跑，零依赖，不需要小程序运行时）
 *
 *   node scripts/test_wrongbook.js
 *
 * 为什么需要它：check_miniprogram.js 只审**结构**（类名/tabBar/云函数三件套），
 * 一条页面 JS 行为都查不到。「点『已掌握』→ 本地立刻少一个 → 云端失败要回滚」
 * 这类逻辑改起来极容易回归，且真机上要复现「云端失败」很难手动造。
 *
 * 共享骨架（wx 桩 / 断言 / 页面捕获）见 scripts/_harness.js。
 */
const fs = require('fs')
const { ROOT, tester, stub, installWx, loadPage } = require('./_harness')

/* ---------- 可配置的桩状态 ---------- */
let modalConfirm = true // showModal 是否点「已掌握」
let dismissFails = false // dismiss_wrong 是否失败
let hold = null // 非 null 时 dismissWrong 会挂起不返回，用来验证「乐观更新」

const { navs, calls } = installWx({
  showModal({ success }) {
    calls.push('showModal')
    // 真实 showModal 是异步回调，这里也用异步，才能测出连点锁
    setTimeout(() => success({ confirm: modalConfirm }), 0)
  }
})

stub('miniprogram/utils/api.js', {
  stats: async () => ({
    wrongWords: [
      { _id: 'w4', word: 'acknowledge', phoneticUS: '/əkˈnɒlɪdʒ/', meaning: '承认；答谢' },
      { _id: 'w5', word: 'accommodate', phoneticUS: '/əˈkɒmədeɪt/', meaning: '容纳；适应' },
      { _id: 'w6', word: 'ambiguous', phoneticUS: '/æmˈbɪɡjuəs/', meaning: '模棱两可的' }
    ]
  }),
  dismissWrong: async (wordId) => {
    calls.push('dismissWrong:' + wordId)
    if (dismissFails) throw new Error('MOCK_NETWORK_FAIL')
    if (hold) await new Promise((r) => (hold.release = r)) // 卡住不回包
    return { wordId, updated: 1 }
  }
})
stub('miniprogram/utils/audio.js', {
  stop() {},
  playWord() {
    calls.push('audio.playWord')
  },
  playSentence() {},
  preloadWords: (ws) => calls.push('preloadWords:' + (ws || []).join(',')),
  preloadSentences: () => {}
})
stub('miniprogram/utils/share.js', { toFriend: (o) => o || {} })

const page = loadPage('miniprogram/pages/wrongbook/wrongbook.js')

const ev = (id, word) => ({ currentTarget: { dataset: { id, word } } })
const countDismiss = () => calls.filter((c) => c.startsWith('dismissWrong:')).length

const { t, done } = tester()

;(async () => {
  /* ---------- 静态面：热区关系必须一层父 + 两个 catchtap 子 ---------- */
  const wxml = fs.readFileSync(ROOT + '/miniprogram/pages/wrongbook/wrongbook.wxml', 'utf8')
  t('「已掌握」用 catchtap 拦住冒泡（否则点它只会进复习页）', /catchtap="markMastered"/.test(wxml))
  t('整卡 bindtap=openReview（W2：点卡片进复习页）', /bindtap="openReview"/.test(wxml))
  t('喇叭改用 catchtap=play（自己有热区，且不冒泡触发跳转）', /catchtap="play"/.test(wxml))
  t(
    '整卡带 data-id（openReview 靠它取词）',
    /data-id="\{\{item\._id\}\}"[\s\S]{0,200}?bindtap="openReview"/.test(wxml)
  )
  t('整卡不再直接绑定发音（父热区的行为已换成跳转）', !/bindtap="play"/.test(wxml))

  /* ---------- 基线 ---------- */
  await page.onShow.call(page)
  t('onShow 拉到 3 个错题且已解除 loading', page.data.words.length === 3 && page.data.loading === false)
  t('onShow 顺带把整表错词音频排进预加载（点喇叭 / 进复习都不要再等下载）',
    calls.includes('preloadWords:acknowledge,accommodate,ambiguous'))

  /* ---------- 场景 1：确认 → 乐观移除 + 调云端 ---------- */
  calls.length = 0
  modalConfirm = true
  const gate = { release: null }
  hold = gate
  const p1 = page.markMastered.call(page, ev('w5', 'accommodate'))
  // 排空事件队列：等 showModal 回调 + setData 落地。此时云端**仍未回包**。
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  t(
    '云端未回包时列表就已更新（真·乐观更新，不是等接口）',
    page.data.words.length === 2 && !page.data.words.some((w) => w._id === 'w5')
  )
  if (gate.release) gate.release()
  await p1
  hold = null
  t('云端接口被调用且只调一次', countDismiss() === 1 && calls.includes('dismissWrong:w5'))
  t('成功时不显示错误条', page.data.errTip === '')

  /* ---------- 场景 2：取消 → 什么都不做 ---------- */
  calls.length = 0
  modalConfirm = false
  await page.markMastered.call(page, ev('w4', 'acknowledge'))
  t('取消确认后列表不变', page.data.words.length === 2 && page.data.words.some((w) => w._id === 'w4'))
  t('取消时不调云端接口', countDismiss() === 0)

  /* ---------- 场景 3：云端失败 → 回滚 + 顶部提示（而不是静默不一致） ---------- */
  calls.length = 0
  modalConfirm = true
  dismissFails = true
  await page.markMastered.call(page, ev('w4', 'acknowledge'))
  t('失败后词被放回原位（回滚）', page.data.words.length === 2 && page.data.words.some((w) => w._id === 'w4'))
  t('失败时出现顶部错误提示条', !!page.data.errTip)
  t('失败时没有用 wx.showToast（tab 页有底栏，会被压住，M19-1）', !calls.includes('showToast'))
  dismissFails = false

  /* ---------- 场景 4：连点 → 只生效一次 ---------- */
  calls.length = 0
  modalConfirm = true
  const a = page.markMastered.call(page, ev('w4', 'acknowledge'))
  const b = page.markMastered.call(page, ev('w6', 'ambiguous')) // 确认框还没关就再点
  await Promise.all([a, b])
  t('连点只生效一次（第二次被 _busy 拦住）', countDismiss() === 1)
  t('被拦下的那次没有误伤别的词', page.data.words.some((w) => w._id === 'w6'))

  /* ---------- 场景 5：切走时停播（tab 页走 onHide 不走 onUnload） ---------- */
  t('onHide 存在（tab 页切走要停播，否则喇叭继续响）', typeof page.onHide === 'function')

  /* ---------- 场景 6：W2 点卡片 → 进学习页复习该词 ---------- */
  navs.length = 0
  await page.onShow.call(page) // 回到本页 → 解锁跳转
  page.openReview.call(page, ev('w4', 'acknowledge'))
  t('点卡片跳到学习页并带上该词 id', navs.length === 1 && navs[0] === '/pages/learn/learn?review=w4')
  page.openReview.call(page, ev('w5', 'accommodate')) // 跳转途中再点一次
  t('连点只跳一次（不叠出两层学习页，否则要返回两次）', navs.length === 1)
  await page.onShow.call(page) // 从学习页返回，onShow 解锁
  page.openReview.call(page, ev('w5', 'accommodate'))
  t('返回后可再次点进复习（锁被 onShow 解除）', navs.length === 2 && navs[1] === '/pages/learn/learn?review=w5')

  navs.length = 0
  page.openReview.call(page, { currentTarget: { dataset: {} } })
  t('dataset 里没有 id 时不动（防御）', navs.length === 0)

  done()
})()
