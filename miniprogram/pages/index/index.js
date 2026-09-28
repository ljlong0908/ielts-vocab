const api = require('../../utils/api')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    summary: {},
    flow: null,
    ctaText: '开始今日学习',
    percent: 0,
    statusText: ''
  },

  onShareAppMessage() {
    return share.toFriend({ title: '雅词本｜每天几个雅思词，学完就打卡' })
  },

  onLoad() {
    if (!wx.getStorageSync('onboarded')) {
      wx.redirectTo({ url: '/pages/onboarding/onboarding' })
    }
  },

  onShow() {
    this.load()
  },

  async load() {
    try {
      const [summary, flow] = await Promise.all([api.homeSummary(), api.todayFlow()])
      const goal = summary.dailyGoal || 5
      const learned = summary.learnedToday || 0
      const percent = Math.min(100, Math.round((learned / goal) * 100))
      this.setData({
        loading: false,
        summary,
        flow,
        percent,
        ctaText: this.buildCta(summary, flow),
        statusText: summary.todayDone ? '今天已完成，明天继续保持' : '坚持每天一点，积少成多'
      })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  buildCta(summary, flow) {
    if (summary.todayDone) return '今日已完成，明天见'
    const stage = flow && flow.plan ? flow.plan.stage : 'learning'
    if (stage === 'review') return '先复习昨天的单词'
    if (stage === 'learning') return '开始今日学习'
    if (stage === 'practice') return '去完成今日练习'
    if (stage === 'practice_done') return '完成今日打卡'
    return '开始今日学习'
  },

  onStart() {
    const summary = this.data.summary || {}
    if (summary.todayDone) {
      wx.showToast({ title: '今日已完成', icon: 'none' })
      return
    }
    const stage = this.data.flow && this.data.flow.plan ? this.data.flow.plan.stage : 'learning'
    if (stage === 'review') {
      wx.navigateTo({ url: '/pages/practice/practice?phase=review' })
    } else if (stage === 'practice') {
      wx.navigateTo({ url: '/pages/practice/practice?phase=practice' })
    } else if (stage === 'practice_done') {
      wx.navigateTo({ url: '/pages/checkin/checkin' })
    } else {
      wx.navigateTo({ url: '/pages/learn/learn' })
    }
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/stats' })
  },

  goWrong() {
    wx.navigateTo({ url: '/pages/wrongbook/wrongbook' })
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' })
  }
})
