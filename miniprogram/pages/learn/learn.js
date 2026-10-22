const api = require('../../utils/api')
const audio = require('../../utils/audio')
const share = require('../../utils/share')

/**
 * 预取窗口：从当前词往后预取几张卡。
 * 卡片本身要过云函数（可能还带 AI 补全），音频又要再过一道 audio_cache，
 * 只预取下一张时，遇到「连点下一个」就会在每一张上各等一次网络。
 * 3 张 = 当前 + 后 2 张，拿满一屏的操作余量，又不至于为整组词空跑请求。
 */
const PREFETCH_AHEAD = 3

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
    nextLabel: '下一个',
    // D13 形似词折叠：默认收起。学习页五个卡片纵向堆叠，形似词展开态约占屏 1/4；
    // 翻词不重置（用户收起就一路收起，重置反而每个词都要再点一次）
    similarOpen: false
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
    // 每进一次页面重置卡片预取缓存（页面上一次的生命周期里存的卡不能再复用）
    this.cardCache = {}
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
      // 先把卡与音频取起来，loadCard 再 await 同一份 promise（不会重复请求）
      this.prefetchWindow(0)
      // loadCard 内部已含「进词自动播单词发音」
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
      // 提前把前几张卡和它们的音频取起来 —— 用户还在看进度条/第 1 个词，
      // 第 2、3 个词的卡片与发音已经在本机了
      this.prefetchWindow(0)
      this.loadCard(0)
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  onUnload() {
    audio.stop()
  },

  /**
   * 预取第 i 张卡（幂等：同一张卡只发一次请求，loadCard 与预取窗口共用同一个 promise）
   * 卡片到手后立刻把它会发声的文本排进预加载队列：
   *   · 单词发音（进词自动播要用的）
   *   · 形似词发音（D12：点小喇叭才播，最多 3 个，一起预载避免首播现等）
   *   · 例句整句发音（点喇叭才播，不预载就要现等）
   */
  prefetch(i) {
    const id = this.wordIds && this.wordIds[i]
    if (!id) return null
    if (!this.cardCache[i]) {
      this.cardCache[i] = api
        .wordCard(id)
        .then((card) => {
          this.warmCard(card)
          return card
        })
        .catch(() => {
          // 预取失败不缓存：让 loadCard 走到这一张时正经重试一次并暴露错误
          delete this.cardCache[i]
          return null
        })
    }
    return this.cardCache[i]
  },

  /** 预取窗口：i .. i+PREFETCH_AHEAD-1 */
  prefetchWindow(i) {
    for (let k = i; k < i + PREFETCH_AHEAD; k++) this.prefetch(k)
  },

  /**
   * 把一张卡里会发声的文本排进预加载队列（单词 + 形似词 + 例句）。
   * 形似词走与单词完全相同的 audio.playWord 链路：库内 100 个词有预置音频，
   * 其余走 audio_cache 的 dictvoice 兜底（首次下载即入云缓存，跨用户共享），
   * 因此任何形似词都能发声，不需要为它单独生成音频。
   */
  warmCard(card) {
    if (!card) return
    if (card.word) audio.preloadWords([card.word])
    // 老数据 / 新导入词可能没有 similar 字段：没有就不预载，展示层走「暂缺」
    if (card.similar && card.similar.length) {
      audio.preloadWords(card.similar.map((s) => s.word))
    }
    const en = card.example && card.example.en
    if (en) audio.preloadSentences([en])
  },

  async loadCard(i) {
    this.setData({ cardLoading: true, card: null })
    try {
      // 优先用预取结果：命中时是同步就有，翻页不再等网络
      const card = await (this.prefetch(i) || Promise.resolve(null))
      if (!card) throw new Error('CARD_EMPTY')
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
      // 本地缓存命中时这里几乎无延迟；未命中才走远端流（并在后台落盘，下次即秒播）。
      if (card && card.word) audio.playWord(card.word)
      // 继续往后预取
      this.prefetchWindow(i + 1)
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

  // 形似词发音（D12）：与主词同一链路（四层缓存 + dictvoice 兜底），
  // 卡片到手时已在 warmCard 里预载，点下去基本秒播。
  // 刻意不做「点词跳卡」：那要给 learn 页加第四种模式，而历史上最贵的 bug
  // 正是 learn 页模式混淆（加练/复习词源写错）；形似词只听不看，够用。
  playSimilar(e) {
    const w = e.currentTarget.dataset.word
    if (w) audio.playWord(w)
  },

  // D13 折叠切换：纯 UI 态，不读不写任何云端数据；
  // 形似词为空（暂缺）时点了也没内容可展——wxml 里箭头/计数不渲染，用户没有可点暗示
  toggleSimilar() {
    this.setData({ similarOpen: !this.data.similarOpen })
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
   * 「上一个」：回看上一个单词（2026-10-14 用户要求）。
   *
   * 边界（用户特意叮嘱「注意单词数量边界」）：
   *  · 第 1 个词没有上一个 —— WXML 用 `wx:if="{{index > 0}}"` 直接不渲染按钮，
   *    这里再兜一道 `index <= 0`，双保险（防将来有人把 wx:if 改成常显）；
   *  · 错题复习（W2）只有一张卡，index 恒为 0，按钮同样不会出现；
   *  · 加练续学时词表已滤掉学过的词，「上一个」只在剩余词内回看，
   *    不会把用户带回已经跳过的那几张。
   *
   * 两个刻意的选择：
   *  · 与 next 共用 locked 连点锁（M18）：回看途中连点不会跳两张；
   *  · **不撤 markLearned** —— 走过的词就是学过了，回看只是呈现层的事。
   *    云端 markLearned 是 addToSet（幂等），退回去再进来重复标记无副作用；
   *    若为了「回看清进度」把标记撤掉，用户一路退到第一个词，今日进度就空了。
   */
  prev() {
    if (this.data.locked) return
    const card = this.data.card
    if (!card) return
    if (this.data.index <= 0) return
    this.setData({ locked: true })
    this.loadCard(this.data.index - 1)
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
