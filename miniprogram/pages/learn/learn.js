const api = require('../../utils/api')
const audio = require('../../utils/audio')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    empty: false,
    cardLoading: false,
    card: null,
    index: 0,
    total: 0,
    isLast: false
  },

  onShareAppMessage() {
    const card = this.data.card
    // 有正在看的词就带上，比通用文案更有信息量
    const title = card && card.word ? `雅词本｜记个雅思词：${card.word}` : ''
    return share.toFriend(title ? { title } : undefined)
  },

  async onLoad() {
    try {
      const flow = await api.todayFlow()
      let ids = (flow.plan && flow.plan.newWordIds) || []
      if (!ids.length) {
        const r = await api.startNewWords()
        ids = r.newWordIds || []
      }
      if (!ids.length) {
        this.setData({ loading: false, empty: true })
        return
      }
      this.wordIds = ids
      this.setData({ loading: false, total: ids.length })
      // loadCard 内部已包含「预取下一张」逻辑，此处不重复调用
      this.loadCard(0)
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  onUnload() {
    audio.stop()
  },

  async loadCard(i) {
    this.setData({ cardLoading: true, card: null })
    try {
      const card = await api.wordCard(this.wordIds[i])
      this.setData({
        card,
        index: i,
        cardLoading: false,
        isLast: i === this.wordIds.length - 1
      })
      if (this.wordIds[i + 1]) api.wordCard(this.wordIds[i + 1]).catch(() => {})
    } catch (e) {
      this.setData({ cardLoading: false })
    }
  },

  play() {
    if (this.data.card) audio.playWord(this.data.card.word)
  },

  // 例句读音：音频由本地 Kokoro 预生成（整句），未预置时静默不播
  playExample() {
    const ex = this.data.card && this.data.card.example
    if (ex && ex.en) audio.playSentence(ex.en)
  },

  next() {
    const card = this.data.card
    if (card) api.markLearned(card._id).catch(() => {})
    if (this.data.isLast) {
      wx.redirectTo({ url: '/pages/practice/practice?phase=practice' })
    } else {
      this.loadCard(this.data.index + 1)
    }
  }
})
