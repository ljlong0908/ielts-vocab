const api = require('../../utils/api')
const audio = require('../../utils/audio')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    empty: false,
    phase: 'practice',
    questions: [],
    optKeys: ['A', 'B', 'C', 'D'],
    index: 0,
    q: null,
    selected: -1,
    revealed: false,
    correct: false,
    answerIndex: -1,
    disabled: {}
  },

  onShareAppMessage() {
    return share.toFriend({ title: '雅词本｜做几道雅思词汇小测验，看看能对几个' })
  },

  onLoad(options) {
    const phase = options.phase === 'review' ? 'review' : 'practice'
    this.setData({ phase })
    this.load(phase)
  },

  onUnload() {
    audio.stop()
  },

  async load(phase) {
    try {
      const r = await api.buildQuestions(phase)
      const qs = r.questions || []
      if (!qs.length) {
        this.setData({ loading: false, empty: true })
        return
      }
      this.setData({ loading: false, questions: qs, index: 0, q: qs[0] })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  playStem() {
    if (this.data.q && this.data.q.phonetic) audio.playWord(this.data.q.stem)
  },

  async choose(e) {
    if (this.data.revealed && this.data.correct) return
    const i = Number(e.currentTarget.dataset.index)
    if (this.data.disabled[i]) return

    let res
    try {
      res = await api.submitAnswer({
        phase: this.data.phase,
        questionIndex: this.data.index,
        choice: i
      })
    } catch (err) {
      return
    }

    const patch = { selected: i, revealed: true, correct: res.correct, answerIndex: res.answerIndex }
    if (!res.correct) {
      const d = Object.assign({}, this.data.disabled)
      d[i] = true
      patch.disabled = d
    }
    this.setData(patch)

    if (res.correct) {
      if (res.word) audio.playWord(res.word)
      setTimeout(() => this.next(), 900)
    }
  },

  next() {
    const n = this.data.index + 1
    if (n >= this.data.questions.length) {
      if (this.data.phase === 'review') {
        wx.redirectTo({ url: '/pages/learn/learn' })
      } else {
        wx.redirectTo({ url: '/pages/checkin/checkin' })
      }
      return
    }
    this.setData({
      index: n,
      q: this.data.questions[n],
      selected: -1,
      revealed: false,
      correct: false,
      answerIndex: -1,
      disabled: {}
    })
  }
})
