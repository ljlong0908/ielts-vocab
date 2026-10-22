'use strict'
/**
 * 练习页（practice）逻辑自测 —— node 直跑，零依赖，不需要小程序运行时
 *
 *   node scripts/test_practice.js
 *
 * 为什么需要它 —— 练习页有两处**不显然**的判断：
 *
 * ① 判题时机：答案随题目下发（`q.answerIndex`），点选**本地同步判对错**，不等云函数；
 *    `submit_answer` 退化为后台落库。三条相关约束必须钉住：
 *      · 判题结果不能依赖落库回包（否则又变回「等网络」）；
 *      · 落库必须**串行**（submit_answer 是「读整个 queue→改→写回」，并发会互相覆盖）；
 *      · 跳转前必须**等落库排空**（finish_checkin 校验 practiceQueue 全 passed，
 *        而 passed 是 submit_answer 写的 —— 不等就会「题全答对了却提示没做完」）。
 *
 * ② 发声位置：两道题的英文词位置不同（见 cloudfunctions/build_questions.toClient）：
 *      · cn_option（中选英）：stem 是英文词 → 发音读 stem
 *      · en_option（英选中）：stem 是中文释义 → 发音读选项里那个英文词
 *    预加载若判据用错（例如看 `phonetic` 是否为空），没有音标的 cn_option 会把 4 个中文
 *    释义当英文词送进音频队列（云端一律拒绝，白跑一趟）。这条 check_miniprogram.js 查不到。
 *
 * 顺带守护既有的空态 / 出口分支 / 降级路径（云函数忘记升级时的兜底）。
 *
 * 共享骨架（wx 桩 / 断言 / 页面捕获）见 scripts/_harness.js。
 */
const { ROOT, drain, tester, stub, installWx, loadPage, snap, pick } = require('./_harness')

const calls = []
/** 可配置的桩状态 */
let questions = []
/** 默认落库实现；各场景可换成「卡住 / 手动控制 / 永远失败」来钉时序 */
const defaultSubmit = (payload) => {
  calls.push('submitAnswer:' + payload.questionIndex + ':' + payload.choice)
  return Promise.resolve({})
}
let submitImpl = defaultSubmit

global.getCurrentPages = () => [{}]

const { navs, calls: wxCalls } = installWx()
stub('miniprogram/utils/api.js', {
  buildQuestions: async (phase, round) => {
    calls.push('buildQuestions:' + phase + ':' + round)
    return { questions }
  },
  submitAnswer: (payload) => submitImpl(payload),
  finishExtraRound: async (roundId) => {
    calls.push('finishExtraRound:' + roundId)
    return {}
  }
})
stub('miniprogram/utils/audio.js', {
  stop() {
    calls.push('audio.stop')
  },
  playWord: (w) => calls.push('playWord:' + w),
  playSentence: () => calls.push('playSentence'),
  preloadWords: (ws) => calls.push('preloadWords:' + (ws || []).join(',')),
  preloadSentences: () => calls.push('preloadSentences')
})
stub('miniprogram/utils/share.js', { toFriend: (o) => o || {} })

// 答题正确后页面用 setTimeout(…, 900) 自动翻到下一题；
// 测试里把长延时压成 0，免得为了断言自动翻页真的等 0.9 秒。
const realSetTimeout = global.setTimeout
global.setTimeout = (fn, ms) => realSetTimeout(fn, ms >= 900 ? 20 : ms)

const page = loadPage('miniprogram/pages/practice/practice.js')
const reset = snap(page, ['round', 'phase'])

const { t, done } = tester()

const preloads = () => pick(calls, 'preloadWords:').map((c) => c.slice('preloadWords:'.length))
const submits = () => pick(calls, 'submitAnswer:').map((c) => c.slice('submitAnswer:'.length))
const tap = (i) => ({ currentTarget: { dataset: { index: String(i) } } })
const settle = () => new Promise((r) => realSetTimeout(r, 40))
const fresh = () => {
  reset()
  calls.length = 0
  questions = []
  submitImpl = defaultSubmit
  page._chain = null
  page._syncWarned = false
}

/* 两种题型的样本（字段名与 build_questions 的下发结构对齐，含 answerIndex / audioText） */
const cnQ = (word, answerIndex = 1, phonetic = '/test/') => ({
  id: word + '_0',
  wordId: 'w_' + word,
  type: 'cn_option',
  stem: word,
  phonetic,
  options: ['承认', '否认', '忽略', '坚持'],
  answerIndex,
  audioText: word
})
const enQ = (options, answerIndex = 0) => ({
  id: 'e_0',
  wordId: 'w_e',
  type: 'en_option',
  stem: '容纳；适应',
  phonetic: '',
  options,
  answerIndex,
  audioText: options[answerIndex]
})
/** 老协议题（云函数未升级、下发时剔了答案）—— 用来测降级路径 */
const legacyQ = () => ({
  id: 'x_0',
  wordId: 'w_x',
  type: 'cn_option',
  stem: 'abandon',
  phonetic: '/test/',
  options: ['承认', '否认', '忽略', '坚持']
})

;(async () => {
  /* ---------- 静态面 ---------- */
  const wxml = require('fs').readFileSync(ROOT + '/miniprogram/pages/practice/practice.wxml', 'utf8')
  t('题干发音仍只挂在有音标的题上（phonetic 为空时喇叭不出现）', /\{\{q\.phonetic\}\}/.test(wxml))
  // 复习 tag 不带时间断言（D14）：复习池=在池未出池的词，正常日子也只是昨日新词的
  // 子集，断档 N 天是 N 天前的词 —— 「昨日」「到期」都不准。防手滑改回。
  t('复习 phase 的 tag 是「复习单词」（无时间断言，防改回昨日/到期）',
    /phase === 'review' \? '复习单词'/.test(wxml) && !/复习昨日|复习到期/.test(wxml))
  // 词根拆解（D15）：题干区 = 单词 → 音标 → 词根 → 选项。
  // 只在 cn_option（题干英文单词）展示：en_option 题干是中文释义，露词根=给选项送答案。
  t('题干区有词根块（q-card 内、选项区之前）',
    /q-card[\s\S]*?q-roots[\s\S]*?class="options"/.test(wxml))
  t('词根块只在 cn_option 渲染（en_option 露词根等于送答案）',
    /wx:if="\{\{q\.type === 'cn_option' && q\.roots && q\.roots\.length\}\}"/.test(wxml))
  t('词根行用 wx:key="part"（与 learn 页词根一致，防重复 key 静默错位）',
    /wx:for="\{\{q\.roots\}\}" wx:key="part"/.test(wxml))
  // 加载提示只保留 wx.showLoading 弹层（D16 同类去重，当天漏了练习页）：
  // api.buildQuestions 的 loadingText「生成练习」是全屏 mask 弹层，页面级
  // 「生成练习中」文字与之重复；弹层关闭与 setData 只差一个微任务，无感知空档。
  // 防手滑把页面级加载文字加回来。
  t('练习页无页面级加载文字（弹层已全屏 mask，重复提示删掉）',
    !/class="loading"/.test(wxml))

  /* ---------- 预加载：中选英读 stem ---------- */
  fresh()
  questions = [cnQ('abandon'), cnQ('dwell')]
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  t('cn_option：预载题干英文词（点喇叭读的就是它）', preloads().join('|') === 'abandon,dwell')
  t('cn_option：不预载中文选项（那是释义，云端一律拒绝）',
    !preloads().join(',').includes('承认'))

  /* ---------- 预加载：cn_option 但没音标（判据必须是 type，不能看 phonetic） ---------- */
  fresh()
  questions = [cnQ('abandon', 0, '')]
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  t('cn_option 没有音标时：仍预载题干英文词（判据用 type，不看 phonetic）',
    preloads().join(',') === 'abandon')
  t('cn_option 没有音标时：不能把中文选项当英文词送进音频队列',
    !preloads().join(',').includes('承认'))

  /* ---------- 预加载：英选中读选项 ---------- */
  fresh()
  questions = [enQ(['acknowledge', 'accommodate', 'ambiguous', 'dwell'])]
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  t('en_option：预载 4 个英文选项（答对后的反馈音必在其中）',
    preloads().join(',') === 'acknowledge,accommodate,ambiguous,dwell')
  t('en_option：不拿中文题干去查音频', !preloads().join(',').includes('容纳'))
  t('en_option：题干 phonetic 为空 → 喇叭不发声（行为不变）', pick(calls, 'playWord').length === 0)

  /* ---------- 预加载：两种题型混排 ---------- */
  fresh()
  questions = [cnQ('abandon'), enQ(['dwell', 'ignore', 'maintain', 'reject'])]
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  t('混排：两类文本都进同一个预加载队列',
    preloads().join(',') === 'abandon,dwell,ignore,maintain,reject')

  /* ---------- 空题组：不预载、给出空态 ---------- */
  fresh()
  questions = []
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  t('空题组：置 empty，不预加载任何音频', page.data.empty === true && preloads().length === 0)

  /* ---------- 本地判题：答对（落库请求卡住不回包也要出结果） ---------- */
  fresh()
  questions = [cnQ('abandon', 1), cnQ('dwell', 0)]
  let dispatched = 0
  submitImpl = () => {
    dispatched++
    return new Promise(() => {}) // 永不回包：模拟弱网
  }
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  calls.length = 0
  await page.choose.call(page, tap(1))
  await drain()
  t('本地判题：落库还没回包，界面已出结果（不再等一次云函数往返）',
    page.data.revealed === true && page.data.correct === true && page.data.answerIndex === 1)
  t('本地判题：反馈音播的是题目自带的 audioText', pick(calls, 'playWord:').join() === 'playWord:abandon')
  t('本地判题：仍然把这次作答发给后台落库（正确率/错题本要靠它）', dispatched === 1)
  await settle()
  t('答对：自动翻到下一题（不用手动点）', page.data.index === 1 && page.data.revealed === false)

  /* ---------- 本地判题：答错 → 不播词、禁掉该项、留在本题 ---------- */
  fresh()
  questions = [cnQ('abandon', 2), cnQ('dwell', 0)]
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  calls.length = 0
  await page.choose.call(page, tap(0))
  await drain()
  t('答错：即时判定为错 + 标出正确答案',
    page.data.revealed === true && page.data.correct === false && page.data.answerIndex === 2)
  t('答错：不播词', pick(calls, 'playWord').length === 0)
  t('答错：把选错的那个选项禁掉，其余仍可点', page.data.disabled['0'] === true)
  t('答错：不自动翻页，留在本题', page.data.index === 0)

  /* ---------- 本地判题：答错后重选仍即时 ---------- */
  calls.length = 0
  await page.choose.call(page, tap(3))
  await drain()
  t('改选：仍然即时判定（不用等落库）', page.data.correct === false && page.data.disabled['3'] === true)
  await page.choose.call(page, tap(0))
  await drain()
  t('改选：已禁的选项再点无效（不重复落库）', submits().length === 1)

  /* ---------- 复习重进：已 passed 的题直接放过，不要求重答（R3，2026-10-13）---------- */
  // 场景：复习中途退出 → build_questions 复用整条 queue（含上次已答对的题）。
  // 队列顺序动不得（questionIndex 是 submit_answer 的落库下标），只能在呈现层跳过。
  fresh()
  const passedQ = cnQ('abandon', 1)
  passedQ.passed = true
  questions = [passedQ, cnQ('dwell', 0)]
  await page.onLoad.call(page, { phase: 'review' })
  await drain()
  t('重进复习：第 1 题已 passed → 载入即呈已答对态（不要求重答）',
    page.data.revealed === true && page.data.correct === true && page.data.selected === 1)
  t('重进复习：已 passed 的题不重复落库（records 会多出同题第二条）', submits().length === 0)
  await settle()
  t('重进复习：自动过到未答的下一题（正常待答态）',
    page.data.index === 1 && page.data.revealed === false && page.data.q === questions[1])

  // 已 passed 的题呈现期间点选项：无反应、不落库、不跳题
  fresh()
  questions = [passedQ, cnQ('dwell', 0)]
  await page.onLoad.call(page, { phase: 'review' })
  await drain()
  calls.length = 0
  await page.choose.call(page, tap(1))
  await drain()
  t('重进复习：已 passed 的题点选项无反应（choose 首行拦截）', submits().length === 0 && page.data.index === 0)

  // 整组都已 passed（上次全答完但没跳走）→ 连过到出口，不死锁
  navs.length = 0
  fresh()
  const p1 = cnQ('abandon', 0); p1.passed = true
  const p2 = cnQ('dwell', 1); p2.passed = true
  questions = [p1, p2]
  await page.onLoad.call(page, { phase: 'review' })
  await drain()
  await settle()
  await settle()
  t('整组已 passed：连过到出口回学习页（不卡在已答对的题上）',
    navs[navs.length - 1] === '/pages/learn/learn')

  /* ---------- 落库串行：并发会互相覆盖云端 queue ---------- */
  fresh()
  questions = [cnQ('abandon', 1)]
  const pending = []
  submitImpl = (payload) => {
    calls.push('submitAnswer:' + payload.questionIndex + ':' + payload.choice)
    return new Promise((res) => pending.push(res))
  }
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  calls.length = 0
  page.choose.call(page, tap(0))
  page.choose.call(page, tap(2))
  page.choose.call(page, tap(3))
  await drain()
  t('串行落库：第一条没回包，后面的不发出（云端 queue 是读改写，并发必互相覆盖）',
    submits().length === 1)
  pending.shift()()
  await drain()
  t('串行落库：第一条回包后才发第二条', submits().length === 2)
  pending.shift()()
  await drain()
  t('串行落库：第二条回包后才发第三条', submits().length === 3)
  pending.shift()()
  await drain()
  t('串行落库：三次点击全部落库，且顺序 = 点击顺序',
    submits().join('|') === '0:0|0:2|0:3')

  /* ---------- 落库失败：重试一次 + 显式提示（不能静默） ---------- */
  fresh()
  questions = [cnQ('abandon', 1)]
  let attempts = 0
  submitImpl = () => {
    attempts++
    return Promise.reject(new Error('network'))
  }
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  calls.length = 0
  wxCalls.length = 0
  await page.choose.call(page, tap(1))
  await drain()
  await drain()
  t('落库失败：自动重试一次', attempts === 2)
  t('落库失败：显式提示用户（静默失败 = 数据缺口，本项目高频坑）', wxCalls.includes('showToast'))
  t('落库失败：不影响已判出的结果', page.data.correct === true)

  /* ---------- 跳转前必须等落库排空 ---------- */
  fresh()
  questions = [cnQ('abandon', 1)]
  let resolved = false
  submitImpl = () =>
    new Promise((res) =>
      realSetTimeout(() => {
        resolved = true
        res({})
      }, 25)
    )
  const realRedirect = global.wx.redirectTo
  let resolvedAtNav = null
  global.wx.redirectTo = ({ url }) => {
    resolvedAtNav = resolved
    navs.push(url)
  }
  navs.length = 0
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  await page.choose.call(page, tap(1))
  await settle()
  t('最后一题答完：先等落库回包再跳（否则打卡会判「还有题没做完」）',
    resolvedAtNav === true && navs[navs.length - 1] === '/pages/checkin/checkin')
  global.wx.redirectTo = realRedirect

  /* ---------- 降级路径：题目不带答案（云函数没升级） ---------- */
  fresh()
  questions = [legacyQ()]
  submitImpl = (payload) => {
    calls.push('submitAnswer:' + payload.questionIndex + ':' + payload.choice)
    return Promise.resolve({ correct: true, answerIndex: 2, word: 'abandon' })
  }
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  calls.length = 0
  await page.choose.call(page, tap(0))
  await drain()
  t('降级：题目不带 answerIndex 时回退服务端判题（不把选项全判错、卡死用户）',
    page.data.correct === true && page.data.answerIndex === 2)
  t('降级：音源取自服务端返回的 word', pick(calls, 'playWord:').join() === 'playWord:abandon')

  // 降级路径仍有在途锁：同题连点只提交一次
  fresh()
  questions = [legacyQ()]
  let legacyDispatched = 0
  submitImpl = () => {
    legacyDispatched++
    return new Promise(() => {}) // 卡在途中
  }
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  calls.length = 0
  page.choose.call(page, tap(0))
  page.choose.call(page, tap(1))
  await drain()
  t('降级：在途时第二次点击被拦住（否则 records 会落多条同题记录）', legacyDispatched === 1)

  /* ---------- 出口：三种阶段的最后一题 ---------- */
  // 普通练习 → 打卡页
  navs.length = 0
  fresh()
  questions = [cnQ('abandon', 0)]
  await page.onLoad.call(page, { phase: 'practice' })
  await drain()
  await page.choose.call(page, tap(0))
  await settle()
  await drain()
  t('普通练习答完最后一题 → 去打卡页', navs[navs.length - 1] === '/pages/checkin/checkin')

  // 复习阶段 → 回学习页
  navs.length = 0
  fresh()
  questions = [cnQ('abandon', 0)]
  await page.onLoad.call(page, { phase: 'review' })
  await drain()
  await page.choose.call(page, tap(0))
  await settle()
  await drain()
  t('复习阶段答完 → 回学习页', navs[navs.length - 1] === '/pages/learn/learn')

  // 加练组 → 先结算再回首页（⛔ 不走 checkin）
  navs.length = 0
  fresh()
  questions = [cnQ('abandon', 0)]
  await page.onLoad.call(page, { phase: 'practice', round: '7' })
  await drain()
  await page.choose.call(page, tap(0))
  await settle()
  await drain()
  t('加练答完 → 结算该组', pick(calls, 'finishExtraRound').join() === 'finishExtraRound:7')
  t('加练答完 → 回首页 tab（不写打卡）', navs[navs.length - 1] === 'switchTab:/pages/index/index')
  t('加练答完 → 不去打卡页', !navs.includes('/pages/checkin/checkin'))

  // 加练提交必须带 round，否则会写进主练习队列
  fresh()
  questions = [cnQ('abandon', 1), cnQ('dwell', 0)]
  let extraRound = null
  submitImpl = (payload) => {
    extraRound = payload.round
    return Promise.resolve({})
  }
  await page.onLoad.call(page, { phase: 'practice', round: '5' })
  await drain()
  await page.choose.call(page, tap(0))
  await drain()
  t('加练提交带上 round（否则会覆盖主练习队列）', extraRound === 5)

  done()
})()
