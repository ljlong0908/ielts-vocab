/**
 * 云函数调用统一封装
 * 约定：所有云函数返回 { code: 0, data, message }
 */
const config = require('../config')

function call(name, data = {}, options = {}) {
  const { loading = true, loadingText = '加载中', silent = false } = options
  if (loading) {
    wx.showLoading({ title: loadingText, mask: true })
  }
  return wx.cloud
    .callFunction({ name, data })
    .then((res) => {
      if (loading) wx.hideLoading()
      const r = res.result || {}
      if (r.code !== 0) {
        if (!silent) {
          wx.showToast({ title: r.message || '请求失败', icon: 'none' })
        }
        const err = new Error(r.message || 'REQUEST_FAILED')
        err.code = r.code
        throw err
      }
      return r.data
    })
    .catch((err) => {
      if (loading) wx.hideLoading()
      if (!silent && !err.code) {
        wx.showToast({ title: '网络异常，请重试', icon: 'none' })
      }
      throw err
    })
}

module.exports = {
  call,

  /** 获取/创建用户；action='setGoal' 时写入每日目标 */
  getProfile(dailyGoal) {
    const data = dailyGoal ? { action: 'setGoal', dailyGoal } : { action: 'get' }
    return call(config.FN.USER_PROFILE, data, { loading: false })
  },

  /** 首页汇总数据 */
  homeSummary() {
    return call(config.FN.HOME_SUMMARY, {}, { loading: false })
  },

  /** 当日流程状态 */
  todayFlow() {
    return call(config.FN.TODAY_FLOW, {})
  },

  /** 标记某词已学习（静默，用于进度条） */
  markLearned(wordId) {
    return call(config.FN.TODAY_FLOW, { action: 'markLearned', wordId }, {
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

  /** 生成练习题（词范围由云函数从当日 plan 自行推导，前端只需给阶段） */
  buildQuestions(phase) {
    return call(config.FN.BUILD_QUESTIONS, { phase }, { loadingText: '生成练习' })
  },

  /** 提交作答 */
  submitAnswer(payload) {
    return call(config.FN.SUBMIT_ANSWER, payload, { loading: false, silent: true })
  },

  /** 完成打卡 */
  finishCheckin() {
    return call(config.FN.FINISH_CHECKIN, {}, { loadingText: '打卡中' })
  },

  /** 统计 */
  stats() {
    return call(config.FN.STATS, {}, { loading: false })
  }
}
