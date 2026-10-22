'use strict'
/**
 * 学习页（learn）逻辑自测 —— node 直跑，零依赖，不需要小程序运行时
 *
 *   node scripts/test_learn.js
 *
 * 为什么需要它：learn 页有**三种模式**，词源完全不同，而项目里最贵的坑就在这儿 ——
 *   · round=0 主流程：读 today_flow，next 时写 markLearned
 *   · round>0 加练（M13）：读 plan.extraRounds，markLearned 必须带 round
 *   · review=<id> 错题复习（W2）：词源只来自参数，**绝不能碰当日进度**
 * 加练那次就是「读错词源 / 写错记录」出的问题（首页今日进度虚涨、主流程被顶掉）。
 * 复习模式同理：一旦顺手调了 start_new_words，点一下错题本就会推进当日游标。
 * 这类「不该调什么」的约束，check_miniprogram.js 一条都查不到。
 *
 * 共享骨架（wx 桩 / 断言 / 页面捕获）见 scripts/_harness.js。
 */
const fs = require('fs')
const { ROOT, drain, tester, stub, installWx, loadPage, snap, pick } = require('./_harness')

/* ---------- 可配置的桩状态 ---------- */
let todayFlowData = { plan: { newWordIds: ['a1', 'a2'] } }
let stackDepth = 2 // getCurrentPages().length：2 = 从错题本 navigateTo 进来
/** 这些 wordId 取卡会失败（验证「预取失败不缓存 → 下次会重试」） */
const failIds = new Set()
/** 这些 wordId 取卡会挂起，直到 holds[id]() 被调用（验证预取是并行的） */
const holdIds = new Set()
const holds = {}
/** 形似词数据（D12）：按 id 注入；没有的 id = 老数据「无该字段」的降级路径 */
const similarFor = {
  s1: [
    { word: 'simA', phonetic: '/a/', meaning: '释义A' },
    { word: 'simB', phonetic: '/b/', meaning: '释义B' }
  ],
  s2: [] // 空数组：库内无形似词 → 「暂缺」态
}

global.getCurrentPages = () => new Array(stackDepth).fill({})

const { navs, calls } = installWx()

stub('miniprogram/utils/api.js', {
  todayFlow: async () => {
    calls.push('todayFlow')
    return todayFlowData
  },
  startNewWords: async () => {
    calls.push('startNewWords')
    return { newWordIds: ['fallback1'] }
  },
  startExtraRound: async () => {
    calls.push('startExtraRound')
    return { roundId: 9, wordIds: ['fallback9'] }
  },
  wordCard: async (id) => {
    calls.push('wordCard:' + id)
    if (failIds.has(id)) throw new Error('CARD_FAIL')
    if (holdIds.has(id)) await new Promise((r) => (holds[id] = r))
    const card = { _id: id, word: 'w_' + id, example: { en: 'Sentence for ' + id + '.' } }
    // similarFor 里有的才带 similar 字段；没有的 id 模拟「老数据没有该字段」
    if (similarFor[id]) card.similar = similarFor[id]
    return card
  },
  markLearned: async (id, round) => {
    calls.push('markLearned:' + id + ':' + round)
  }
})
stub('miniprogram/utils/audio.js', {
  playWord: (w) => calls.push('playWord:' + w),
  playSentence: () => calls.push('playSentence'),
  stop: () => calls.push('audio.stop'),
  preloadWords: (ws) => calls.push('preloadWords:' + (ws || []).join(',')),
  preloadSentences: (ts) => calls.push('preloadSentences:' + (ts || []).join(','))
})
stub('miniprogram/utils/share.js', { toFriend: (o) => o || {} })

const page = loadPage('miniprogram/pages/learn/learn.js')
const reset = snap(page, ['reviewId', 'round', 'cardCache'])
const fresh = () => {
  reset()
  page.wordIds = []
  failIds.clear()
  calls.length = 0
  navs.length = 0
}

const cards = () => pick(calls, 'wordCard:')
const api = (p) => pick(calls, p)

const { t, done } = tester()

;(async () => {
  /* ---------- 静态面 ---------- */
  const wxml = fs.readFileSync(ROOT + '/miniprogram/pages/learn/learn.wxml', 'utf8')
  t('learn 头部有「错题复习」文案', wxml.includes('错题复习'))
  t('底栏按钮文案收敛到 nextLabel（四种模式在一处算）', /\{\{nextLabel\}\}/.test(wxml))
  t('wxml：「上一个」按钮存在且绑 prev', /bindtap="prev"/.test(wxml))
  t('wxml：「上一个」按 index>0 条件渲染（首词不显示，边界前置）',
    /wx:if="\{\{index > 0\}\}"[\s\S]*?bindtap="prev"/.test(wxml))

  /* ---------- 静态面：形似词（D12，2026-10-22） ---------- */
  t('wxml：有「形似词」区块', /<text>形似词<\/text>/.test(wxml))
  t('wxml：形似词区块在主卡之后、例句之前（D12-2 位置决策）',
    wxml.indexOf('<text>形似词</text>') < wxml.indexOf('<text>例句</text>'))
  t('wxml：每行形似词绑 playSimilar 且带 data-word',
    /bindtap="playSimilar"[\s\S]*?data-word="\{\{item.word\}\}"/.test(wxml) ||
    /data-word="\{\{item.word\}\}"[\s\S]*?bindtap="playSimilar"/.test(wxml))
  t('wxml：similar 用 && 兜底再取 length（老数据无该字段不能炸页面）',
    /wx:if="\{\{card\.similar && card\.similar\.length\}\}"/.test(wxml))

  /* ---------- 静态面：形似词折叠（D13，2026-10-22） ---------- */
  t('wxml：形似词在词根拆解之后（D13 楼层调整后的顺序）',
    wxml.indexOf('<text>词根拆解</text>') < wxml.indexOf('<text>形似词</text>'))
  t('wxml：标题行整行可点，绑 toggleSimilar',
    /class="sec-title sec-head"[^>]*bindtap="toggleSimilar"/.test(wxml))
  t('wxml：内容区 block wx:if 带 similarOpen（默认收起不渲染，省高度）',
    /<block wx:if="\{\{card\.similar && card\.similar\.length && similarOpen\}\}"/.test(wxml))
  t('wxml：空态走 wx:elif 暂缺（有值收起时两个分支都不渲染，不是 bug）',
    /wx:elif="\{\{!card\.similar \|\| !card\.similar\.length\}\}"/.test(wxml))
  t('wxml：箭头/计数只在 similar 有长度时渲染（暂缺态无可点暗示）',
    /wx:if="\{\{card\.similar && card\.similar\.length\}\}"[^>]*class="sec-arrow/.test(wxml))
  t('wxss：sec-arrow 有定义（check ② 会抓漏类名）',
    fs.existsSync(ROOT + '/miniprogram/pages/learn/learn.wxss') &&
      /\.sec-arrow\s*\{/.test(fs.readFileSync(ROOT + '/miniprogram/pages/learn/learn.wxss', 'utf8')))

  /* ---------- 模式一：review 错题复习（W2） ---------- */
  fresh()
  await page.onLoad.call(page, { review: 'w4' })
  await drain()
  t('review：只取参数里那一个词', cards().length === 1 && cards()[0] === 'wordCard:w4')
  t('review：不读 today_flow', !calls.includes('todayFlow'))
  t('review：不调 start_new_words（否则会推进当日游标，点一下就污染今日进度）', !calls.includes('startNewWords'))
  t('review：不调 start_extra_round', !calls.includes('startExtraRound'))
  t('review：头部切到「错题复习」', page.data.isReview === true && page.data.isExtra === false)
  t('review：单卡 1/1', page.data.total === 1 && page.data.index === 0 && page.data.isLast === true)
  t('review：底栏按钮为「复习完成」', page.data.nextLabel === '复习完成')
  t('review：进词仍自动播一次发音', api('playWord').length === 1 && calls.includes('playWord:w_w4'))

  // 出口行为
  calls.length = 0
  navs.length = 0
  await page.next.call(page)
  await drain()
  t('review：点「复习完成」返回上一页（错题本）', navs.length === 1 && navs[0] === 'navigateBack')
  t('review：不写 markLearned（复习 ≠ 已掌握，也不该改当日进度）', api('markLearned').length === 0)
  t('review：不跳练习页', !navs.some((u) => String(u).includes('practice')))
  t('review：离开前停播（不把喇叭带回去）', calls.includes('audio.stop'))

  // 连点锁定（M18）
  fresh()
  await page.onLoad.call(page, { review: 'w4' })
  await drain()
  page.next.call(page)
  page.next.call(page)
  await drain()
  t('review：连点「复习完成」只返回一次', navs.length === 1)

  // 无上一页的兜底（被分享 / 冷启直达）
  stackDepth = 1
  fresh()
  await page.onLoad.call(page, { review: 'w7' })
  await drain()
  await page.next.call(page)
  await drain()
  t('review：没有上一页时退回错题本 tab（tab 页只能 switchTab）', navs[0] === 'switchTab:/pages/wrongbook/wrongbook')
  stackDepth = 2

  /* ---------- 模式二：round=0 主流程（不得回归） ---------- */
  todayFlowData = { plan: { newWordIds: ['a1', 'a2'] } }
  fresh()
  await page.onLoad.call(page, {})
  await drain()
  t('主流程：读 today_flow 拿当日新词', calls.includes('todayFlow') && cards()[0] === 'wordCard:a1')
  t('主流程：不误入复习 / 加练模式', page.data.isReview === false && page.data.isExtra === false)
  t('主流程：首词按钮为「下一个」', page.data.nextLabel === '下一个' && page.data.isLast === false)

  calls.length = 0
  navs.length = 0
  await page.next.call(page)
  await drain()
  t('主流程：「下一个」仍写 markLearned（round=0）', calls.includes('markLearned:a1:0'))
  t('主流程：「下一个」不跳页，只翻卡', navs.length === 0 && page.data.index === 1)
  t('主流程：最后一词按钮为「开始练习」', page.data.nextLabel === '开始练习')

  calls.length = 0
  navs.length = 0
  await page.next.call(page)
  await drain()
  t('主流程：最后一词跳练习页（不带 round）', navs[0] === '/pages/practice/practice?phase=practice')

  /* ---------- 模式三：round>0 加练（M13，不得回归） ---------- */
  todayFlowData = { plan: { extraRounds: [{ roundId: 2, wordIds: ['e1', 'e2'] }] } }
  fresh()
  await page.onLoad.call(page, { round: '2' })
  await drain()
  t('加练：词源取 extraRounds 里 roundId=2 的组', cards()[0] === 'wordCard:e1' && calls.includes('todayFlow'))
  t('加练：不调 start_new_words（不碰主流程 newWordIds）', !calls.includes('startNewWords'))
  t('加练：头部为「加练单词」', page.data.isExtra === true && page.data.isReview === false)

  calls.length = 0
  await page.next.call(page)
  await drain()
  t('加练：markLearned 带 round=2（否则会写进主流程进度）', calls.includes('markLearned:e1:2'))
  t('加练：最后一词按钮为「开始加练小测」', page.data.nextLabel === '开始加练小测')

  navs.length = 0
  await page.next.call(page)
  await drain()
  t('加练：最后一词跳练习页并带 round', navs[0] === '/pages/practice/practice?phase=practice&round=2')

  /* ---------- 模式三之二：中途退出再进来，要跳过已学过的词 ---------- */
  // 用户 2026-09-29 拍板：恢复未完成的组时从「下一个没学的词」继续，不从第 1 个重看
  todayFlowData = {
    plan: { extraRounds: [{ roundId: 3, wordIds: ['e1', 'e2', 'e3'], learnedIds: ['e1'] }] }
  }
  fresh()
  await page.onLoad.call(page, { round: '3' })
  await drain()
  t('加练续学：跳过已学过的 e1，直接从 e2 开始', cards()[0] === 'wordCard:e2')
  t('加练续学：不进 start_extra_round（plan 里有该组）', !calls.includes('startExtraRound'))
  t('加练续学：进度只反映剩余词数（3 个里剩 2 个）', page.data.total === 2)
  t('加练续学：分段条也随之只剩 2 段', page.data.segs.length === 2)
  t('加练续学：仍标记为加练模式', page.data.isExtra === true)

  /* ---------- 模式三之三：词都学完了但小测没做 → 直接进小测 ---------- */
  todayFlowData = {
    plan: { extraRounds: [{ roundId: 4, wordIds: ['e1', 'e2'], learnedIds: ['e1', 'e2'], stage: 'learning' }] }
  }
  fresh()
  await page.onLoad.call(page, { round: '4' })
  await drain()
  t('加练续学：词全学完 → 直接跳小测（不显示空列表）',
    navs[0] === '/pages/practice/practice?phase=practice&round=4')
  t('加练续学：全学完时不取任何单词卡', !calls.some((c) => c.startsWith('wordCard:') && !c.includes('empty')))

  /* ---------- 「上一个」按钮（2026-10-14 用户要求；重点在单词数量边界） ---------- */
  todayFlowData = { plan: { newWordIds: ['b1', 'b2', 'b3'] } }
  fresh()
  await page.onLoad.call(page, {})
  await drain()

  // 边界①：第 1 个词没有上一个 —— 按钮不渲染（wxml 静态已断言），JS 再兜一道
  calls.length = 0
  await page.prev.call(page)
  await drain()
  t('上一个：第 1 个词点「上一个」什么都不发生（单词数量边界）',
    page.data.index === 0 && page.data.card._id === 'b1' && cards().length === 0 && calls.length === 0)

  // 正常回看：b1 → b2 → 回 b1
  await page.next.call(page)
  await drain()
  t('上一个：先前进到第 2 个词', page.data.index === 1 && page.data.card._id === 'b2')
  calls.length = 0
  await page.prev.call(page)
  await drain()
  t('上一个：回到上一个词', page.data.index === 0 && page.data.card._id === 'b1')
  t('上一个：回看用已缓存卡片，不发新请求（走过的词就在本机）', cards().length === 0)
  t('上一个：底栏按钮回到「下一个」', page.data.nextLabel === '下一个')
  t('上一个：分段进度跟着回退（第 1 段回 cur、第 2 段清空）',
    page.data.segs[0].cls === 'cur' && page.data.segs[1].cls === '')
  t('上一个：回看仍自动播该词发音', calls.includes('playWord:w_b1'))
  t('上一个：不撤 markLearned（走过的词就是学过了；addToSet 幂等，撤了才会让今日进度造假）',
    !calls.some((c) => c.startsWith('markLearned')))

  // 边界②：与 next 共用 M18 连点锁，回看途中连点不会连退两张
  await page.next.call(page)
  await drain()
  page.setData({ locked: true })
  page.prev.call(page)
  await drain()
  t('上一个：locked 时点不动（与 next 共用 M18 连点锁）', page.data.index === 1)
  page.setData({ locked: false })

  // 边界③：错题复习（W2）只有一张卡，index 恒 0，没有「上一个」
  fresh()
  await page.onLoad.call(page, { review: 'w4' })
  await drain()
  calls.length = 0
  await page.prev.call(page)
  await drain()
  t('review：单卡没有「上一个」（index 恒 0，JS 兜底拦住）',
    page.data.index === 0 && page.data.card._id === 'w4' && calls.length === 0)

  /* ---------- 预取 + 预加载（发声延迟优化的核心，不得回归） ---------- */
  // 目标：翻页与发音都不该现等网络。卡片要过云函数（可能还带 AI 补全），
  // 音频要再过一道 audio_cache —— 只提前一张就来不及，整组空跑又浪费。
  todayFlowData = { plan: { newWordIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] } }
  fresh()
  await page.onLoad.call(page, {})
  await drain()
  t('预取：只取窗口内 4 张，不为整组 6 个词空跑请求',
    cards().join(',') === 'wordCard:p1,wordCard:p2,wordCard:p3,wordCard:p4')
  t('预取：预取与 loadCard 共用同一 promise（同一张卡只请求一次）',
    cards().filter((c) => c === 'wordCard:p1').length === 1)
  t('预取：卡片到手立刻排入「词 + 例句」音频预加载',
    api('preloadWords').includes('preloadWords:w_p1') &&
      api('preloadSentences').includes('preloadSentences:Sentence for p1.'))

  calls.length = 0
  await page.next.call(page)
  await drain()
  t('预取：翻页时下一张已在手，不为它发请求', !cards().includes('wordCard:p2'))
  t('预取：窗口随之前移，只补取更远的那张', cards().join(',') === 'wordCard:p5')
  t('预取：翻页照旧自动播词', calls.includes('playWord:w_p2'))

  // 预取失败不能把这一张「毒」掉：失败不入缓存，下次预取必须重新请求。
  // 这条直接对 prefetch 下断言（不走整页流程）——失败与 loadCard 的先后
  // 落在微任务顺序里，靠整页流程断言会变成一条时快时慢的脆测试。
  calls.length = 0
  failIds.add('x1')
  page.cardCache = {}
  page.wordIds = ['x1']
  await page.prefetch.call(page, 0)
  t('预取失败：失败结果不留在缓存里（否则这张卡永远白屏）', page.cardCache[0] === undefined)
  await page.prefetch.call(page, 0)
  t('预取失败：下次预取会重新请求', cards().filter((c) => c === 'wordCard:x1').length === 2)

  // W2 错题复习：从错题本点进来是「即点即看」，更不能等下载
  fresh()
  await page.onLoad.call(page, { review: 'r9' })
  await drain()
  t('review：单卡同样预载词音频', api('preloadWords').includes('preloadWords:w_r9'))

  // 预取的真正价值是**并行**：把第 1 张卡的请求扣住不回包，
  // 后 2 张仍必须已经在路上。否则就是串行（第 2 张要等第 1 张一个完整往返），
  // 用户看到的正是「点下一个之后才转圈」。
  holdIds.add('hp1')
  todayFlowData = { plan: { newWordIds: ['hp1', 'hp2', 'hp3', 'hp4', 'hp5'] } }
  fresh()
  page.onLoad.call(page, {}) // 故意不 await：第 1 张卡此时被扣住
  await drain()
  t('预取：第 1 张卡还没回来，后 2 张已经在路上（并行而非串行）',
    cards().join(',') === 'wordCard:hp1,wordCard:hp2,wordCard:hp3')
  t('预取：也只为窗口内这几张并行，没整组铺开',
    !cards().includes('wordCard:hp4') && !cards().includes('wordCard:hp5'))
  holdIds.clear()
  Object.keys(holds).forEach((k) => {
    holds[k]()
    delete holds[k]
  })
  await drain()

  /* ---------- 形似词（D12，2026-10-22）：预加载 + 点播 + 降级 ---------- */
  // 数据来自 words.similar（gen_similar.py 离线算，seed_similar.py 播种），
  // 云函数零改动；前端只负责展示、预载与播放，不读不写任何用户态。

  // ① 有形似词：卡片到手就把形似词发音一起排进预加载（点喇叭不等网络）
  // 注意：形似词是**一次** preloadWords 调用（数组拼接成一条记录），
  // 断言要按整串精确匹配 —— api() 的 includes 是数组成员比较，不是子串。
  todayFlowData = { plan: { newWordIds: ['s1'] } }
  fresh()
  await page.onLoad.call(page, {})
  await drain()
  t('形似词：预加载带上形似词发音（simA/simB 一次调用）',
    api('preloadWords').includes('preloadWords:simA,simB'))
  t('形似词：主词发音仍照旧预载（不被形似词挤掉）',
    api('preloadWords').includes('preloadWords:w_s1'))

  // ② 点形似词喇叭 → 播该词发音（与主词同链路：四层缓存 + dictvoice 兜底）
  calls.length = 0
  await page.playSimilar.call(page, { currentTarget: { dataset: { word: 'simA' } } })
  await drain()
  t('形似词：点喇叭播放该形似词发音', calls.includes('playWord:simA'))

  // ③ 负向：wxml 漏传 data-word 时不播（防御将来有人改坏模板）
  calls.length = 0
  await page.playSimilar.call(page, { currentTarget: { dataset: {} } })
  await drain()
  t('形似词：缺 data-word 时不播（负向验证）',
    !calls.some((c) => c.startsWith('playWord')))

  // ④ 空数组：库内无形似词 → 展示层「暂缺」，预加载不多发
  todayFlowData = { plan: { newWordIds: ['s2'] } }
  fresh()
  await page.onLoad.call(page, {})
  await drain()
  t('形似词：similar 为空数组时页面照常出卡', page.data.card && page.data.card._id === 's2')
  t('形似词：空数组不多发预加载（只有主词一次）',
    api('preloadWords').join(',') === 'preloadWords:w_s2')

  // ⑤ 无字段：老数据 / 将来 seed_words 导入的新词没有 similar → 不能炸
  todayFlowData = { plan: { newWordIds: ['s3'] } }
  fresh()
  await page.onLoad.call(page, {})
  await drain()
  t('形似词：没有 similar 字段时页面照常出卡（老数据降级）',
    page.data.card && page.data.card._id === 's3' && page.data.cardLoading === false)
  t('形似词：无字段时预加载只有主词一次（&& 兜底生效）',
    api('preloadWords').join(',') === 'preloadWords:w_s3')
  t('形似词：无字段时例句预加载不受影响（回归）',
    api('preloadSentences').includes('preloadSentences:Sentence for s3.'))

  /* ---------- 形似词折叠（D13，2026-10-22）：默认收起 + 切换 ---------- */
  // ⑤ 折叠态：默认收起；toggleSimilar 来回切
  fresh()
  await page.onLoad.call(page, {})
  await drain()
  t('折叠：默认收起（similarOpen=false，省高度）', page.data.similarOpen === false)
  page.toggleSimilar()
  t('折叠：点一次标题行 → 展开', page.data.similarOpen === true)
  page.toggleSimilar()
  t('折叠：再点一次 → 收起', page.data.similarOpen === false)
  // 翻词不重置：模拟 next 后 similarOpen 保持用户选择
  page.toggleSimilar()
  await page.next.call(page)
  await drain()
  t('折叠：翻词不重置（用户收起就一路收起）', page.data.similarOpen === true)
  // ⑥ 空态/无字段时点了也不炸（状态可切，但 wxml 两道 wx:if 保证无列表可展）
  fresh()
  await page.onLoad.call(page, { review: 's2' })
  await drain()
  page.toggleSimilar() // 不抛异常即通过（真炸了这里测试直接红）
  t('折叠：空数组词页面 toggleSimilar 不炸、卡片数据完好',
    page.data.card && page.data.card._id === 's2')
  fresh()
  await page.onLoad.call(page, { review: 's3' })
  await drain()
  page.toggleSimilar()
  t('折叠：无字段词页面 toggleSimilar 不炸、卡片数据完好（老数据降级）',
    page.data.card && page.data.card._id === 's3')

  done()
})()
