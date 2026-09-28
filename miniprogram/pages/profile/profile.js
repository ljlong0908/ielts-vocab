const api = require('../../utils/api')
const config = require('../../config')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    user: {},
    options: config.DAILY_GOAL_OPTIONS
  },

  onShareAppMessage() {
    return share.toFriend()
  },

  async onShow() {
    try {
      const user = await api.getProfile()
      this.setData({ loading: false, user })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  async setGoal(e) {
    const goal = Number(e.currentTarget.dataset.value)
    if (this.data.user && this.data.user.dailyGoal === goal) return
    try {
      const user = await api.getProfile(goal)
      this.setData({ user })
      wx.showToast({ title: '已更新，次日生效', icon: 'none' })
    } catch (err) {
      /* 已由 api 层提示 */
    }
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/stats' })
  },

  goWrong() {
    wx.navigateTo({ url: '/pages/wrongbook/wrongbook' })
  }
})
