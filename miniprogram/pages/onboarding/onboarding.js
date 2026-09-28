const api = require('../../utils/api')
const config = require('../../config')
const share = require('../../utils/share')

Page({
  data: {
    options: config.DAILY_GOAL_OPTIONS,
    selected: 5,
    submitting: false
  },

  onShareAppMessage() {
    return share.toFriend()
  },

  choose(e) {
    this.setData({ selected: Number(e.currentTarget.dataset.value) })
  },

  async confirm() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    try {
      await api.getProfile(this.data.selected)
      wx.setStorageSync('onboarded', true)
      wx.reLaunch({ url: '/pages/index/index' })
    } catch (e) {
      this.setData({ submitting: false })
    }
  }
})
