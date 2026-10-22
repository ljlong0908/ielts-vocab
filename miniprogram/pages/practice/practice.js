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
    // 降级路径（云函数未升级、题目不带 answerIndex）下的提交在途锁：防同题连点落多条 records
    submitting: false
  },

  onShareAppMessage() {
    return share.toFriend({ title: '雅词本｜做几道词汇小测验，看看能对几个' })
  },

  onLoad(options) {
    const phase = options.phase === 'review' ? 'review' : 'practice'
    const round = Number(options && options.round) || 0
    // 落库失败只提示一次（每答一题弹一次会刷屏）；重新进页面再给一次机会
    this._syncWarned = false
    // 后台落库的串行链：同题连点 / 连续答题都排在一条链上，避免云端 queue 读改写互相覆盖
    this._chain = null
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
      this.setData({ loading: false, questions: qs })
      this.applyQuestion(0)
      this.preloadAll(qs)
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  /**
   * 预载本组题会发声的英文文本。
   * 两类题型能发声的位置不同（字段含义见 build_questions.toClient）：
   *   · cn_option（中选英）：stem 是英文词、带 phonetic → 预载 stem（点喇叭读的就是它）
   *   · en_option（英选中）：stem 是中文释义 → 预载 4 个选项里的英文词，
   *     答对后 playWord(q.audioText) 的那个词必在其中，反馈音因此也是即时的
   * ⚠️ 判据必须用 type，不能看 `phonetic` 是否为空：没有音标的 cn_option
   *    会走进 else 分支，把 4 个中文释义当英文词送进音频队列（云端一律拒绝，白跑）。
   */
  preloadAll(qs) {
    const words = []
    ;(qs || []).forEach((q) => {
      if (!q) return
      if (q.type === 'cn_option') words.push(q.stem)
      else (q.options || []).forEach((o) => words.push(o))
    })
    audio.preloadWords(words)
  },

  playStem() {
    if (this.data.q && this.data.q.phonetic) audio.playWord(this.data.q.stem)
  },

  /**
   * 判题。
   * 主路径：答案随题目下发（`q.answerIndex`）→ **本地同步判对错**，点下去立即出结果、立即发音，
   *         不再等一次云函数往返。submit_answer 退化为**后台落库**
   *         （records / user_words / plan.stage 仍归它写，见 syncAnswer）。
   * 降级路径：题目不带 answerIndex（云函数还是老版本、下发时剔了答案）→ 只能等服务端判题；
   *         行为与旧版完全一致，只是慢。留着它是为了避免「前端更新了、云函数忘了传」时卡死用户
   *         （缺答案时每个选项都会被判错，最后全禁掉，用户无路可走）。
   */
  async choose(e) {
    if (this.data.revealed && this.data.correct) return
    if (this.data.submitting) return
    const i = Number(e.currentTarget.dataset.index)
    if (this.data.disabled[i]) return
    const q = this.data.q
    if (!q) return

    const payload = {
      phase: this.data.phase,
      round: this.data.round,
      questionIndex: this.data.index,
      choice: i
    }

    let correct
    let answerIndex
    let word = ''
    if (typeof q.answerIndex === 'number') {
      correct = i === q.answerIndex
      answerIndex = q.answerIndex
      word = q.audioText || ''
      this.syncAnswer(payload) // 刻意不 await：判题结果已经在手里了
    } else {
      this.setData({ submitting: true })
      let res
      try {
        res = await api.submitAnswer(payload)
      } catch (err) {
        this.setData({ submitting: false })
        return
      }
      this.setData({ submitting: false })
      correct = res.correct
      answerIndex = res.answerIndex
      word = res.word || ''
    }

    const patch = {
      selected: i,
      revealed: true,
      correct,
      answerIndex
    }
    if (!correct) {
      const d = Object.assign({}, this.data.disabled)
      d[i] = true
      patch.disabled = d
    }
    this.setData(patch)

    if (correct) {
      // 主路径读题目自带的 audioText（不再等服务端把 word 带回来）；
      // 降级路径只能读服务端返回的 word
      if (word) audio.playWord(word)
      setTimeout(() => this.next(), 900)
    }
  },

  /**
   * 后台落库（submit_answer）。
   * ⚠️ **串行**：submit_answer 是「读整个 queue → 改 → 写回整个 queue」，
   *    并发提交会互相覆盖（后写的把先写的 passed/wrong 抹掉）。一条链串住所有提交。
   * ⚠️ 失败要**显式提示**：判题已在本地完成，落库静默失败 = 正确率 / 错题本 / 复习调度静默缺口。
   *    先重试一次（网络抖动），仍失败才提示，且每页只提示一次（每答一题弹一次会刷屏）。
   */
  syncAnswer(payload) {
    const send = (retry) =>
      api.submitAnswer(payload).catch(() => {
        if (retry) return send(false)
        if (!this._syncWarned) {
          this._syncWarned = true
          wx.showToast({ title: '答题记录未同步，请检查网络', icon: 'none' })
        }
      })
    this._chain = (this._chain || Promise.resolve()).then(() => send(true))
    return this._chain
  },

  /**
   * 等落库链排空。跳转前必须等：
   * finish_checkin 的前置校验是「practiceQueue 全部 passed」，而 passed 是 submit_answer 写的 ——
   * 不等就会出现「题全答对了，打卡却提示没做完」。
   */
  flushSync() {
    return this._chain || Promise.resolve()
  },

  /**
   * 呈现第 i 题（载入首页与翻页共用同一入口）。
   * 已 `passed` 的题（复习中途退出后重进 —— build_questions 复用整条 queue，
   * 含上次已答对的题）直接呈已答对态并自动过：不要求用户重答。
   * ⚠️ 只能在这里「呈现层跳过」：questionIndex 是 queue 下标，
   *    submit_answer 按下标落库，队列顺序动不得（过滤/重排都会错位）。
   */
  applyQuestion(i) {
    const q = this.data.questions[i]
    const patch = {
      index: i,
      q,
      selected: -1,
      revealed: false,
      correct: false,
      answerIndex: -1,
      disabled: {}
    }
    if (q && q.passed) {
      patch.selected = q.answerIndex
      patch.revealed = true
      patch.correct = true
      patch.answerIndex = q.answerIndex
    }
    this.setData(patch)
    if (patch.revealed) setTimeout(() => this.next(), 900)
  },

  async next() {
    const n = this.data.index + 1
    if (n >= this.data.questions.length) {
      await this.flushSync()
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
    this.applyQuestion(n)
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
