const api = require('../../utils/api')
const audio = require('../../utils/audio')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    words: []
  },

  onShareAppMessage() {
    const n = (this.data.words || []).length
    const title = n > 0 ? `雅词本｜我的错题本里有 ${n} 个待攻克雅思词` : ''
    return share.toFriend(title ? { title } : undefined)
  },

  async onShow() {
    try {
      const r = await api.stats()
      this.setData({ loading: false, words: r.wrongWords || [] })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  onUnload() {
    audio.stop()
  },

  play(e) {
    const word = e.currentTarget.dataset.word
    if (word) audio.playWord(word)
  }
})
