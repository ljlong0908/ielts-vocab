const api = require('../../utils/api')
const audio = require('../../utils/audio')
const quotes = require('../../utils/quotes')
const share = require('../../utils/share')

Page({
  data: {
    loading: true,
    summary: {},
    flow: null,
    ctaText: '开始今日学习',
    percent: 0,
    statusText: '',
    quote: null,
    // 朋友圈「单页模式」（scene 1154）：无登录态、读不到云端数据，
    // 走专门降级视图（品牌 + 每日一句），不出打卡/进度 UI
    singlePage: false,
    // M13 加练按钮（D1=A：仅当日已打卡后出现）
    extraShow: false,
    extraDisabled: false,
    extraText: '',
    extraSize: 0,
    extraBusy: false,
    // 加练失败时的底栏提示（页面有固定底栏，M19a 规定不用 wx.showToast）
    extraTip: ''
  },

  onShareAppMessage() {
    return share.toFriend({ title: '雅词本｜每天几个词，学完就打卡' })
  },

  // 朋友圈分享：只有首页开（其他页面强依赖云端流程，单页模式打开会空白，
  // 原因见 utils/share.js 头注释）。单页模式降级视图见 onShow 里的 scene 判断。
  onShareTimeline() {
    return share.toTimeline()
  },

  onLoad() {
    // 朋友圈单页模式：scene 1154。此时存储是隔离的（getStorageSync('onboarded')
    // 必为空），绝不能走 reLaunch 到 onboarding——单页模式不允许页面跳转，
    // 跳了也没用还可能报错。直接进降级视图。
    if (wx.getLaunchOptionsSync().scene === 1154) {
      this.setData({ singlePage: true })
      return
    }
    if (!wx.getStorageSync('onboarded')) {
      // ⚠️ index 现在是 tabBar 页：redirectTo 会关掉 tab 页、把 tabBar 留在错误状态，
      //    必须用 reLaunch（它可以打开任意页，包括离开 tab 页）
      wx.reLaunch({ url: '/pages/onboarding/onboarding' })
    }
  },

  onShow() {
    this.load()
  },

  async load() {
    // 每日一句是本地静态语料，不依赖网络，先放上去免得等接口时卡片闪一下
    // （单页模式下也靠它撑起整个落地页）
    if (!this.data.quote) this.setData({ quote: quotes.today() })
    // 单页模式：无登录态，云端调用必然失败，直接出静态视图
    if (this.data.singlePage) {
      this.setData({ loading: false })
      return
    }
    try {
      const [summary, flow] = await Promise.all([api.homeSummary(), api.todayFlow()])
      const goal = summary.dailyGoal || 5
      const learned = summary.learnedToday || 0
      const percent = Math.min(100, Math.round((learned / goal) * 100))
      this.setData(Object.assign({
        loading: false,
        summary,
        flow,
        percent,
        // 从加练页返回时会走 onShow → load，这里顺手把在途标志复位
        extraBusy: false,
        ctaText: this.buildCta(summary, flow),
        statusText: summary.todayDone ? '今天已完成，明天继续保持' : '坚持每天一点，积少成多'
      }, this.buildExtra(summary, flow)))
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  buildCta(summary, flow) {
    if (summary.todayDone) return '今日已完成，明天见'
    const stage = flow && flow.plan ? flow.plan.stage : 'learning'
    if (stage === 'review') return '先复习昨天的单词'
    if (stage === 'learning') return '开始今日学习'
    if (stage === 'practice') return '去完成今日练习'
    if (stage === 'practice_done') return '完成今日打卡'
    return '开始今日学习'
  },

  /**
   * M13「再学一组」显隐（D1=A：仅当日已打卡后可用）
   *  - 未打卡 → 整个隐藏（此时它本就不该存在，隐藏不会造成困惑）
   *  - 有未完成的组 → **必须显示**，文案改「继续学一组」
   *  - 词库取尽 / 已达上限 → 显示但置灰，并把原因写在底栏
   *
   * ⚠️ 两条踩过的坑，改动前先读：
   *  ① `limitReached` **不能先于** `pendingRound` 判断。曾经写成
   *     `if (limitReached) return hide`，结果：建满 3 组后中途退出，
   *     首页按钮就此消失 —— 用户手里那组永远学不完，且**云端 canStart 明明是 true**
   *     （`canStart = 已打卡 && (有未完成组 || 未达上限未取尽)`）。
   *     症状是「刚才还能再学一组，现在不行了」，极易被当成后端没部署。
   *  ② `flow.extra` 是随加练一起新增的字段，云端 today_flow 若还是旧版就没有它。
   *     此时**绝不能静默隐藏按钮**——那会让「后端没部署」表现为「功能没实现」，
   *     排查成本极高（本项目已踩过）。退化为乐观显示：已打卡即可加练，
   *     组大小取每日目标；真点了由 startExtraRound 报错，信息落在底栏 extraTip。
   */
  buildExtra(summary, flow) {
    const hide = { extraShow: false, extraDisabled: false, extraText: '', extraSize: 0, extraTip: '' }
    if (!summary.todayDone) return hide

    const ex = flow && flow.extra
    if (!ex) {
      return {
        extraShow: true,
        extraDisabled: false,
        extraText: '再学一组',
        extraSize: summary.dailyGoal || 5,
        extraTip: ''
      }
    }

    const size = ex.groupSize || summary.dailyGoal || 5

    // ① 有未完成的组 → 必须能进（哪怕已建满上限）：让用户把手上这组学完
    if (ex.pendingRound) {
      return { extraShow: true, extraDisabled: false, extraText: '继续学一组', extraSize: size, extraTip: '' }
    }

    // ② 词库取尽 → 置灰 + 说清原因（不静默消失）
    if (ex.exhausted) {
      return {
        extraShow: true,
        extraDisabled: true,
        extraText: '再学一组',
        extraSize: 0,
        extraTip: '预置发音的词已学完，等新一批音频补上就能继续'
      }
    }

    // ③ 已达上限且无未完成组 → 同样保留按钮并说明，避免「按钮凭空消失」
    //    （M13 原设计是整个隐藏；改为置灰+提示，理由同上面的坑①）
    if (ex.limitReached) {
      return {
        extraShow: true,
        extraDisabled: true,
        extraText: '再学一组',
        extraSize: 0,
        extraTip: '今日加练已达上限，明天可继续'
      }
    }

    return { extraShow: true, extraDisabled: false, extraText: '再学一组', extraSize: size, extraTip: '' }
  },

  onStart() {
    const summary = this.data.summary || {}
    if (summary.todayDone) {
      wx.showToast({ title: '今日已完成', icon: 'none' })
      return
    }
    const stage = this.data.flow && this.data.flow.plan ? this.data.flow.plan.stage : 'learning'
    if (stage === 'review') {
      wx.navigateTo({ url: '/pages/practice/practice?phase=review' })
    } else if (stage === 'practice') {
      wx.navigateTo({ url: '/pages/practice/practice?phase=practice' })
    } else if (stage === 'practice_done') {
      wx.navigateTo({ url: '/pages/checkin/checkin' })
    } else {
      wx.navigateTo({ url: '/pages/learn/learn' })
    }
  },

  /**
   * M13：发起加练。startExtraRound 本身幂等（存在未完成的组会原样返回），
   * 不需要自己做防抖；用 extraBusy 挡住「请求在途时连点」即可。
   */
  async onExtra() {
    if (this.data.extraBusy || this.data.extraDisabled) return
    this.setData({ extraBusy: true, extraTip: '' })
    try {
      const r = await api.startExtraRound()
      if (r.exhausted) {
        this.setData({ extraBusy: false, extraDisabled: true, extraText: '词库已学完', extraSize: 0 })
        return
      }
      wx.navigateTo({ url: '/pages/learn/learn?round=' + r.roundId })
    } catch (e) {
      // M19a：本页有固定底栏，不用 wx.showToast（位置不可控、会被按钮压住），
      //       把原因写在底栏里。带上原始 message，避免又出现「点了没反应」。
      const msg = (e && e.message) || ''
      console.warn('[extra] startExtraRound 失败：', e)
      this.setData({
        extraBusy: false,
        extraTip: msg ? '加练不可用：' + String(msg).slice(0, 44) : '加练暂时不可用，请稍后再试'
      })
    }
  },

  // 每日一句发音：复用例句音频链路（整句预生成），未预置时静默
  playQuote() {
    const q = this.data.quote
    if (q && q.text) audio.playSentence(q.text)
  },

  // index 是 tab 页：切 tab 只触发 onHide 不触发 onUnload，所以停播要挂在 onHide
  onHide() {
    audio.stop()
  },

  onUnload() {
    audio.stop()
  }
})
