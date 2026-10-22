const api = require('../../utils/api')
const audio = require('../../utils/audio')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    words: [],
    // 操作失败提示条（错题本是 tab 页，禁用 wx.showToast，见 wxml 注释）
    errTip: ''
  },

  onShareAppMessage() {
    const n = (this.data.words || []).length
    const title = n > 0 ? `雅词本｜我的错题本里有 ${n} 个待攻克的词` : ''
    return share.toFriend(title ? { title } : undefined)
  },

  async onShow() {
    this.clearTip()
    // 回到本页即解锁跳转（从学习页返回、或切回本 tab）；连点锁只在跳转途中生效
    this._jumping = false
    try {
      const r = await api.stats()
      const words = r.wrongWords || []
      this.setData({ loading: false, words })
      // 错词表一次也就几个词，整表预载：点喇叭、点进复习页都不会再有等待。
      // 预加载是排队 + 限并发的，不会把首屏请求挤掉。
      audio.preloadWords(words.map((w) => w.word))
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  // 错题本是 tab 页：切 tab 只触发 onHide、不触发 onUnload，所以停播要挂 onHide，
  // 否则切走之后喇叭还在响。
  onHide() {
    audio.stop()
    this.clearTip()
  },

  onUnload() {
    audio.stop()
    this.clearTip()
  },

  play(e) {
    const word = e.currentTarget.dataset.word
    if (word) audio.playWord(word)
  },

  /**
   * W2 点卡片 → 进学习页复习这个词（learn 页 ?review=<wordId>，单卡模式）。
   * 三个要点：
   *  ① learn 是普通页（非 tab）→ navigateTo 保留页面栈，返回键 / 「复习完成」都能退回本页；
   *  ② 返回时本页 onShow 会重新拉 stats → 复习期间的变化（如在别处标了已掌握）自动反映；
   *  ③ _jumping 连点锁：navigateTo 有延迟，连点会叠出两层学习页（返回一次还停在学习页）。
   */
  openReview(e) {
    if (this._jumping) return
    const id = e.currentTarget.dataset.id
    if (!id) return
    this._jumping = true
    // id 是云数据库文档 id，编码一下避免特殊字符破坏 query
    wx.navigateTo({
      url: '/pages/learn/learn?review=' + encodeURIComponent(id),
      // 跳转失败（如页面栈已满 10 层）要解锁，否则整页卡片再也点不动
      complete: () => {
        this._jumping = false
      }
    })
  },

  /**
   * 标记为「已掌握」→ 从错题本移除。
   * 三步：① 二次确认（移除后列表里就没了，给一次反悔机会）
   *       ② 乐观移除（先本地摘掉，点完立刻看到结果，不等云函数往返）
   *       ③ 失败回滚 + 顶部提示条 —— 不静默失败，避免 UI 与云端不一致
   */
  async markMastered(e) {
    // 连点锁：确认框还开着的时候不再响应第二次点击（否则会连弹、甚至误删别的词）
    if (this._busy) return
    const id = e.currentTarget.dataset.id
    const word = e.currentTarget.dataset.word || '这个词'
    if (!id) return

    this._busy = true
    try {
      const ok = await new Promise((resolve) => {
        wx.showModal({
          title: '标记为已掌握',
          content: `${word} 将从错题本移除，之后答错还会自动回来。`,
          confirmText: '已掌握',
          cancelText: '取消',
          success: (r) => resolve(!!r.confirm),
          fail: () => resolve(false)
        })
      })
      if (!ok) return

      const before = this.data.words
      this.setData({ words: before.filter((x) => x._id !== id) })
      try {
        await api.dismissWrong(id)
      } catch (err) {
        // 云端没成功就把词放回去 —— 绝不静默把界面和云端弄得不一致
        this.setData({ words: before })
        this.showTip('没能移除，请稍后重试')
      }
    } finally {
      this._busy = false
    }
  },

  showTip(msg) {
    this.clearTip()
    this.setData({ errTip: msg })
    this._tipTimer = setTimeout(() => {
      this._tipTimer = null
      this.setData({ errTip: '' })
    }, 4000)
  },

  clearTip() {
    if (this._tipTimer) {
      clearTimeout(this._tipTimer)
      this._tipTimer = null
    }
  }
})
