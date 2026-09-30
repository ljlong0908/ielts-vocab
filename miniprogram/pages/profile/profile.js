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

  // M5 原生 tabBar：stats / wrongbook 已是 tab 页，navigateTo 到 tab 页会被拒，必须 switchTab
  goStats() {
    wx.switchTab({ url: '/pages/stats/stats' })
  },

  goWrong() {
    wx.switchTab({ url: '/pages/wrongbook/wrongbook' })
  }
})
