const api = require('../../utils/api')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    streak: 0,
    learnedCount: 0,
    totalLearned: 0,
    already: false
  },

  onShareAppMessage() {
    const streak = this.data.streak || 0
    const title = streak > 0 ? `雅词本｜我已连续记词 ${streak} 天` : ''
    return share.toFriend(title ? { title } : undefined)
  },

  async onLoad() {
    try {
      const r = await api.finishCheckin()
      this.setData({
        loading: false,
        streak: r.streak || 0,
        learnedCount: r.learnedCount || 0,
        totalLearned: r.totalLearned || 0,
        already: !!r.already
      })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  }
})
