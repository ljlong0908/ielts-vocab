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
    isLast: false,
    // M13 加练：true 时头部标签改「加练单词」，最后一词跳加练练习
    isExtra: false,
    // W2 错题复习：从错题本点词进来，只复习这一个词，按钮变「复习完成」→ 退回错题本
    isReview: false,
    // M18 连点锁：next() 原本无锁，连点会静默跳过一个词
    locked: false,
    // M6 分段进度：每个词一段，值 = '' | 'cur' | 'done'
    segs: [],
    // 底栏按钮文案（在 loadCard 里按模式算好）：下一个 / 开始练习 / 开始加练小测 / 复习完成
    nextLabel: '下一个'
  },

  onShareAppMessage() {
    const card = this.data.card
    // 有正在看的词就带上，比通用文案更有信息量
    const title = card && card.word ? `雅词本｜记个词：${card.word}` : ''
    return share.toFriend(title ? { title } : undefined)
  },

  /**
   * round=0：今日新词（主流程）
   * round>0（M13 加练）：词源取当日 plan.extraRounds 里 roundId 匹配的组，
   *          绝不碰 plan.newWordIds —— 否则加练会把主流程进度顶掉（C2）。
   *          **会跳过该组已学过的词**（按 learnedIds），全学完则直接跳小测。
   * review=<wordId>（W2 错题复习）：从错题本点某个词进来，只复习这一个词。
   *          词源**直接来自参数**：不读 today_flow、不调 start_new_words ——
   *          那两个会推进当日游标 / 写 learnedIds，点一下错题本就会把今日进度弄乱（同 C2）。
   */
  async onLoad(options) {
    const reviewId = (options && options.review) || ''
    if (reviewId) {
      // 复习模式：单卡、不入任何当日进度统计
      this.reviewId = reviewId
      this.wordIds = [reviewId]
      this.setData({
        loading: false,
        isReview: true,
        total: 1,
        segs: this.buildSegs(0)
      })
      // loadCard 内部已含「进词自动播单词发音」与预取逻辑
      this.loadCard(0)
      return
    }

    const round = Number(options && options.round) || 0
    this.round = round
    try {
      const flow = await api.todayFlow()
      let ids = []
      if (round > 0) {
        const groups = (flow.plan && flow.plan.extraRounds) || []
        let g = groups.filter((x) => x.roundId === round)[0]
        // 兜底：plan 里取不到该组（如冷启直接进该页）→ 让 start_extra_round 幂等返回当前组
        if (!g || !(g.wordIds || []).length) {
          const r = await api.startExtraRound()
          if (r.roundId) this.round = r.roundId
          g = { wordIds: r.wordIds || [], learnedIds: [] }
        }
        // 跳过本组已学过的词：中途退出再进来，直接从下一个没学的继续，
        // 而不是从第 1 个重看一遍。进度条与「N / M」也随之只反映**剩余**词数。
        // （learnedIds 由 today_flow(markLearned, round) 用 addToSet 累积，天然幂等）
        const learned = new Set(g.learnedIds || [])
        ids = (g.wordIds || []).filter((id) => !learned.has(id))
        // 词都看完了但小测没做（组仍 pending）→ 直接进小测，别让用户对着空列表
        if (!ids.length) {
          wx.redirectTo({ url: '/pages/practice/practice?phase=practice&round=' + this.round })
          return
        }
      } else {
        ids = (flow.plan && flow.plan.newWordIds) || []
        if (!ids.length) {
          const r = await api.startNewWords()
          ids = r.newWordIds || []
        }
      }
      if (!ids.length) {
        this.setData({ loading: false, empty: true })
        return
      }
      this.wordIds = ids
      this.setData({
        loading: false,
        total: ids.length,
        isExtra: round > 0,
        segs: this.buildSegs(0)
      })
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
      const isLast = i === this.wordIds.length - 1
      // 底栏按钮文案。复习模式只有一张卡，按钮即出口（点了退回错题本）
      const nextLabel = this.reviewId
        ? '复习完成'
        : isLast
          ? this.round > 0
            ? '开始加练小测'
            : '开始练习'
          : '下一个'
      this.setData({
        card,
        index: i,
        cardLoading: false,
        isLast,
        locked: false,
        nextLabel,
        segs: this.buildSegs(i)
      })
      // 进词即读：进入每个单词页自动播放一次单词发音（首个词与「下一个」都走这里，不必两处写）
      // 放在 setData 之后，让发音与词在同一个渲染批次里出现，避免「先出声、词还没出来」。
      // 连点「下一个」由 locked 挡住；万一仍连续触发，playSrc 内部先 ctx.stop() 再换源，不会叠音。
      if (card && card.word) audio.playWord(card.word)
      if (this.wordIds[i + 1]) api.wordCard(this.wordIds[i + 1]).catch(() => {})
    } catch (e) {
      // 取卡失败必须解锁，否则按钮会永久停在禁用态（锁只在 next() 里加，也要在失败路径里放）
      this.setData({ cardLoading: false, locked: false })
    }
  },

  /**
   * M6 分段进度：cur 之前的段为 done、当前段为 cur、之后为空。
   * 返回对象数组而不是纯字符串数组 —— 字符串数组配 wx:key 没法给唯一键
   * （段值会重复出现 ''），用 wx:key="index" 又不合法，会一直告警。
   */
  buildSegs(cur) {
    const n = this.wordIds ? this.wordIds.length : 0
    const out = []
    for (let k = 0; k < n; k++) {
      out.push({ k: 's' + k, cls: k < cur ? 'done' : k === cur ? 'cur' : '' })
    }
    return out
  },

  play() {
    if (this.data.card) audio.playWord(this.data.card.word)
  },

  // 例句读音：音频由本地 Kokoro 预生成（整句），未预置时静默不播
  playExample() {
    const ex = this.data.card && this.data.card.example
    if (ex && ex.en) audio.playSentence(ex.en)
  },

  // M18 连点防护：无锁时连点两次「下一个」会静默跳过一个词（本次审核唯一在真机复现的连点缺陷）
  next() {
    if (this.data.locked) return
    const card = this.data.card
    if (!card) return
    this.setData({ locked: true })

    // W2 复习模式：按钮就是出口，直接退回错题本。
    // ⚠️ 不调 markLearned —— 复习 ≠ 已掌握（要不要标记由错题本上的按钮决定），
    //    更不能推进当日进度，否则「点一下错题本」就把今日学习数据改了。
    if (this.reviewId) {
      audio.stop()
      this.backToWrongbook()
      return
    }

    // markLearned 是 fire-and-forget，别让它带着 UI 一起冲。
    // 加练必须带 round，否则会写进主流程 learnedIds，让首页「今日进度」虚涨。
    api.markLearned(card._id, this.round || 0).catch(() => {})
    if (this.data.isLast) {
      const tail = this.round > 0 ? '&round=' + this.round : ''
      wx.redirectTo({ url: '/pages/practice/practice?phase=practice' + tail })
    } else {
      this.loadCard(this.data.index + 1)
    }
  },

  /**
   * 退回入口页（错题本）。它是 tab 页：
   * 正常从错题本 navigateTo 进来 → navigateBack 出栈即可；
   * 万一没有上一页（被分享 / 冷启直达）→ 退回错题本 tab，
   * ⚠️ tab 页只能 switchTab（navigateTo 到 tab 页会被拒）。
   */
  backToWrongbook() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/wrongbook/wrongbook' })
  }
})
