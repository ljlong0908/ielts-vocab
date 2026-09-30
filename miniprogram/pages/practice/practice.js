const api = require('../../utils/api')
const audio = require('../../utils/audio')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    empty: false,
    phase: 'practice',
    // M13：round>0 表示加练组；题目与判题都按它路由到 extraRounds
    round: 0,
    questions: [],
    optKeys: ['A', 'B', 'C', 'D'],
    index: 0,
    q: null,
    selected: -1,
    revealed: false,
    correct: false,
    answerIndex: -1,
    disabled: {},
    // 提交在途锁（防止同一题连点落下多条 records）
    submitting: false
  },

  onShareAppMessage() {
    return share.toFriend({ title: '雅词本｜做几道词汇小测验，看看能对几个' })
  },

  onLoad(options) {
    const phase = options.phase === 'review' ? 'review' : 'practice'
    const round = Number(options && options.round) || 0
    this.setData({ phase, round })
    this.load(phase, round)
  },

  onUnload() {
    audio.stop()
  },

  async load(phase, round) {
    try {
      const r = await api.buildQuestions(phase, round)
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
    // 提交在途锁：不加的话同一题连点会在 records 里落下多条记录（T5-1 的下游污染）
    if (this.data.submitting) return
    const i = Number(e.currentTarget.dataset.index)
    if (this.data.disabled[i]) return

    this.setData({ submitting: true })
    let res
    try {
      res = await api.submitAnswer({
        phase: this.data.phase,
        round: this.data.round,
        questionIndex: this.data.index,
        choice: i
      })
    } catch (err) {
      this.setData({ submitting: false })
      return
    }

    const patch = {
      selected: i,
      revealed: true,
      correct: res.correct,
      answerIndex: res.answerIndex,
      submitting: false
    }
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
      // M13 加练：全部答对 → 结算该组再回首页。
      // ⛔ 不走 checkin（加练不写 checkins、不动 streak、不改 plan.stage）
      if (this.data.round > 0) {
        this.finishExtra()
        return
      }
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
  },

  /**
   * M13：结算加练组，然后切回首页。
   * 这里**刻意不用 wx.showToast** —— 首页有固定底栏，toast 会被压在按钮下面（M19a）；
   * 首页 onShow 会重新拉数据，「累计学习」+本组词数、以及「已加练 N 词」都自然显示出来 ——
   * 所以本页不需要自己提示成功（提示失败也没意义：结算幂等，重进加练组还能再结算）。
   */
  async finishExtra() {
    try {
      await api.finishExtraRound(this.data.round)
    } catch (e) {
      // 结算失败不拦用户：finish_extra_round 幂等，重新进加练组还能再结算
    }
    wx.switchTab({ url: '/pages/index/index' })
  }
})
