'use strict'
/**
 * 页面级测试的**共享骨架** —— test_learn / test_index / test_wrongbook / test_audio 等
 * 的公共部分（断言计数、桩注入、wx 桩、页面捕获）都收在这里。
 *
 * 为什么值得抽出来：这四份测试原本各自抄一遍 `t()` 与 wx 桩，20 多行 × 4；
 * 更糟的是 wx 桩各写各的 —— 有的记 navigateBack、有的不记，
 * 「同一件事在两个测试里行为不同」会让失败信号互相矛盾。
 *
 * 做法：`installWx()` 装一个**统一记录型**的全局 wx（所有跳转/提示都进
 *      `navs`，方法调用进 `calls`），再用 `loadPage()` 直跑真实页面 js。
 *      差异化行为（如 showModal 的回包）用 `installWx({ 覆盖项 })` 传入。
 */
const path = require('path')
// 用 timers 的 setTimeout 而不是全局的：部分测试会把 global.setTimeout 改短
// （把 900ms 的自动翻页压成 20ms），看门狗不能跟着被压。
const rawSetTimeout = require('timers').setTimeout

const ROOT = path.resolve(__dirname, '..')

/** 排空一轮事件循环（等 Promise / setTimeout(0) 的回调落地） */
const drain = () => new Promise((r) => setTimeout(r, 0))

/**
 * 断言计数器：t() 记一条，done() 打汇总并按失败数决定退出码。
 *
 * 🐶 看门狗（别删）：断言串在一条 await 链上，任一处**卡在永不回包的 promise**时，
 * node 的事件循环空了就会**静默退出、退出码 0** —— 后面所有断言一条都不跑，
 * 而 CI 看到的是「通过」。这是最难发现的假绿（本项目实测踩过一次：
 * 把判题改回「等云函数」后，测试挂在 await 上，输出戛然而止却报成功）。
 * 跑完会 clearTimeout，正常路径没有额外开销。
 */
function tester(timeoutMs = 8000) {
  let pass = 0
  let fail = 0
  let finished = false
  const dog = rawSetTimeout(() => {
    if (finished) return
    console.log('FAIL  测试未跑完（有调用卡在未回包的 promise 上？）')
    process.exit(1)
  }, timeoutMs)
  return {
    t(label, ok) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
      ok ? pass++ : fail++
    },
    done() {
      finished = true
      clearTimeout(dog)
      console.log(`\n${pass} passed, ${fail} failed`)
      process.exit(fail ? 1 : 0)
    }
  }
}

/** 用 require.cache 注入桩模块（避免真的 require 到页面依赖） */
const stub = (rel, exports) => {
  const p = require.resolve(path.join(ROOT, rel))
  require.cache[p] = { id: p, filename: p, loaded: true, exports }
}

/**
 * 装全局 wx 桩，返回两个流水数组：
 *   navs  —— 路由跳转（navigateTo/redirectTo/switchTab/reLaunch/navigateBack）与 toast
 *   calls —— 其他被观察到的调用（如 'ctx.play'）
 * 覆盖项直接写 `installWx({ showModal({ success }) {...} })`。
 */
function installWx(over = {}) {
  const navs = []
  const calls = []
  global.wx = Object.assign(
    {
      getStorage: ({ fail } = {}) => fail && fail(),
      setStorage() {},
      getStorageSync: () => null,
      setStorageSync() {},
      showToast() {
        calls.push('showToast')
      },
      showModal({ success }) {
        calls.push('showModal')
        setTimeout(() => success({ confirm: true }), 0)
      },
      navigateTo({ url }) {
        navs.push(url)
      },
      navigateBack() {
        navs.push('navigateBack')
      },
      redirectTo({ url }) {
        navs.push(url)
      },
      switchTab({ url }) {
        navs.push('switchTab:' + url)
      },
      reLaunch({ url }) {
        navs.push('reLaunch:' + url)
      },
      getLaunchOptionsSync: () => ({ scene: 1001 }),
      createInnerAudioContext: () => ({
        stop() {},
        play() {
          calls.push('ctx.play')
        },
        onError() {},
        offEnded() {},
        offError() {}
      })
    },
    over
  )
  return { navs, calls }
}

/** require 真实页面 js 并接住 Page(cfg)，补一个直写 data 的 setData */
function loadPage(rel) {
  let page = null
  global.Page = (cfg) => {
    page = cfg
  }
  require(path.join(ROOT, rel))
  page.setData = function (o) {
    Object.assign(this.data, o)
  }
  return page
}

/**
 * 记住页面初始 data，返回 reset()：把 data 恢复初始态并删掉 extra 上挂的属性。
 * ⚠️ 只有 data 会被复位；页面自己挂的属性（如 learn 的 wordIds）需调用方补一行。
 */
function snap(page, deletes = []) {
  const initial = JSON.parse(JSON.stringify(page.data))
  return () => {
    Object.keys(page.data).forEach((k) => delete page.data[k])
    Object.assign(page.data, JSON.parse(JSON.stringify(initial)))
    deletes.forEach((k) => delete page[k])
  }
}

/** calls 里筛出某个前缀的流水，如 pick(calls, 'wordCard:') */
const pick = (calls, prefix) => calls.filter((c) => c.startsWith(prefix))

module.exports = { ROOT, drain, tester, stub, installWx, loadPage, snap, pick }
