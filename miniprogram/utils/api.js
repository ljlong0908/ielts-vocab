/**
 * 云函数调用统一封装
 * 约定：所有云函数返回 { code: 0, data, message }
 *
 * UX 旁路：config.USE_MOCK=true 时优先走 utils/mock.js 本地数据，不联网。
 * 未命中的接口会回退真实云函数，支持「部分 mock」（如真实登录 + mock 内容）。
 */
const config = require('../config')
const mock = require('./mock')

function call(name, data = {}, options = {}) {
  const { loading = true, loadingText = '加载中', silent = false } = options
  if (loading) {
    wx.showLoading({ title: loadingText, mask: true })
  }
  const done = () => {
    if (loading) wx.hideLoading()
  }
  const fail = (msg) => {
    if (!silent) wx.showToast({ title: msg || '请求失败', icon: 'none' })
  }

  // 数据源：USE_MOCK 时先尝试 mock，命中即用，未命中回退真实云函数
  const source = config.USE_MOCK ? mock.handle(name, data) : Promise.resolve(null)

  return source
    .then((res) => {
      // res=null 表示未命中 mock，回退真实云函数
      if (res == null) {
        return wx.cloud.callFunction({ name, data }).then((r) => r.result || {})
      }
      return res
    })
    .then((r) => {
      if (r.code !== 0) {
        done()
        fail(r.message)
        const err = new Error(r.message || 'REQUEST_FAILED')
        err.code = r.code
        throw err
      }
      done()
      return r.data
    })
    .catch((err) => {
      done()
      if (!silent && !err.code) fail('网络异常，请重试')
      throw err
    })
}

module.exports = {
  call,

  /** 获取/创建用户；action='setGoal' 时写入每日目标。
   *  走全局 loading（2026-10-26 去重：页面级「加载中」已删，同义提示只留全局一处） */
  getProfile(dailyGoal) {
    const data = dailyGoal ? { action: 'setGoal', dailyGoal } : { action: 'get' }
    return call(config.FN.USER_PROFILE, data)
  },

  /** 首页汇总数据 */
  homeSummary() {
    return call(config.FN.HOME_SUMMARY, {}, { loading: false })
  },

  /** 当日流程状态 */
  todayFlow() {
    return call(config.FN.TODAY_FLOW, {})
  },

  /** 标记某词已学习（静默，用于进度条）；round>0 时为加练组 */
  markLearned(wordId, round) {
    return call(config.FN.TODAY_FLOW, { action: 'markLearned', wordId, round: round || 0 }, {
      loading: false,
      silent: true
    })
  },

  /** 生成当日新词队列（幂等） */
  startNewWords() {
    return call(config.FN.START_NEW_WORDS, {})
  },

  /** 获取单词卡（含 AI 补全 + 缓存） */
  wordCard(wordId) {
    return call(config.FN.WORD_CARD, { wordId }, { loading: false })
  },

  /** 生成练习题；round>0 表示加练组（云函数按 round 路由队列，避免覆盖主练习） */
  buildQuestions(phase, round) {
    return call(config.FN.BUILD_QUESTIONS, { phase, round: round || 0 }, { loadingText: '生成练习' })
  },

  /** 提交作答（加练需带 round，payload 里带上即可） */
  submitAnswer(payload) {
    return call(config.FN.SUBMIT_ANSWER, payload, { loading: false, silent: true })
  },

  /** 发起「再学一组」（加练）：幂等，未完成的组会原样返回 */
  startExtraRound() {
    return call(config.FN.START_EXTRA_ROUND, {}, { loadingText: '准备加练词' })
  },

  /** 完成一组加练（最后一道加练题答对后调用） */
  finishExtraRound(roundId) {
    return call(config.FN.FINISH_EXTRA_ROUND, { roundId }, { loadingText: '结算加练' })
  },

  /** 完成打卡 */
  finishCheckin() {
    return call(config.FN.FINISH_CHECKIN, {}, { loadingText: '打卡中' })
  },

  /** 统计（错题本/统计页 onShow 首屏）。
   *  走全局 loading（2026-10-26 去重：页面级「加载中」已删，同义提示只留全局一处） */
  stats() {
    return call(config.FN.STATS, {})
  },

  /**
   * 把错题标记为「已掌握」→ 从错题本移除。
   * 失败**不弹 toast**：错题本有固定底栏，toast 会被压住（M19-1 TOAST_COVER），
   * 由页面自绘顶部提示条。故这里 silent:true，把错误交给调用方处理。
   */
  dismissWrong(wordId) {
    return call(config.FN.DISMISS_WRONG, { wordId }, { loading: false, silent: true })
  }
}
