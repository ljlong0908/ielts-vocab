/**
 * mock 层逻辑自测（node 运行，不依赖小程序运行时）
 * 用法：node scripts/test_mock.js
 * 验证 mock.handle 对各接口返回的结构、边界态、场景切换是否正确
 */
const mock = require('../miniprogram/utils/mock')
const config = require('../miniprogram/config')

const FN = config.FN

const cases = [
  ['home_summary', FN.HOME_SUMMARY, {}],
  ['today_flow(get)', FN.TODAY_FLOW, {}],
  ['today_flow(markLearned)', FN.TODAY_FLOW, { action: 'markLearned', wordId: 'w1' }],
  ['user_profile(get)', FN.USER_PROFILE, { action: 'get' }],
  ['user_profile(setGoal=10)', FN.USER_PROFILE, { action: 'setGoal', dailyGoal: 10 }],
  ['start_new_words', FN.START_NEW_WORDS, {}],
  ['word_card(w1 完整)', FN.WORD_CARD, { wordId: 'w1' }],
  ['word_card(w5 暂缺)', FN.WORD_CARD, { wordId: 'w5' }],
  ['word_card(w6 生成中)', FN.WORD_CARD, { wordId: 'w6' }],
  ['word_card(未知id)', FN.WORD_CARD, { wordId: 'zzz' }],
  ['build_questions', FN.BUILD_QUESTIONS, { phase: 'practice' }],
  ['submit_answer(答对)', FN.SUBMIT_ANSWER, { questionIndex: 0, choice: 0 }],
  ['submit_answer(答错)', FN.SUBMIT_ANSWER, { questionIndex: 2, choice: 0 }],
  ['finish_checkin', FN.FINISH_CHECKIN, {}],
  ['stats', FN.STATS, {}],
  ['daily_line', FN.DAILY_LINE, {}],
  // M13/T1 加练
  ['build_questions(round=1)', FN.BUILD_QUESTIONS, { phase: 'practice', round: 1 }],
  ['submit_answer(round=1)', FN.SUBMIT_ANSWER, { phase: 'practice', round: 1, questionIndex: 0, choice: 0 }],
  ['today_flow(get, 含 extra)', FN.TODAY_FLOW, {}],
  ['start_extra_round', FN.START_EXTRA_ROUND, {}],
  ['finish_extra_round', FN.FINISH_EXTRA_ROUND, { roundId: 1 }],
  ['dismiss_wrong(标记已掌握)', FN.DISMISS_WRONG, { wordId: 'w4' }],
  ['audio_cache(应未命中)', FN.AUDIO_CACHE, { text: 'abandon', type: 2 }]
]

;(async () => {
  console.log(`场景: ${mock.getScene()} | 词表 ${mock.getWords().length} 个\n`)
  let pass = 0
  let fail = 0
  for (const [label, name, data] of cases) {
    const r = await mock.handle(name, data)
    const miss = r == null
    const summary = miss
      ? 'NULL(未命中→回退真实)'
      : `code:${r.code} data:${JSON.stringify(r.data).slice(0, 110)}`
    // 简单断言：除 audio_cache 应未命中外，其余应 code:0
    const expectMiss = label.includes('未命中')
    const ok = expectMiss ? miss : (!miss && r.code === 0 && r.data != null)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${summary}`)
    ok ? pass++ : fail++
  }

  // ── 加练（M13/T1）行为体检：幂等复用 + 结算计入累计 ─────────────────
  // 契约 A：连点两次 start_extra_round 只创建一个组（第二次 reused=true 且 roundId 相同）
  // 契约 B：结算时 totalLearned 增量 === 本组词数（D3 已由「不计入」改为「计入」）
  // 契约 C：重复结算幂等（already=true 且不重复累加）—— 计数唯一风险点
  // 契约 D：首页读数同步（防止只改了云函数返回值、忘了写用户文档）
  const base0 = (await mock.handle(FN.HOME_SUMMARY, {})).data.totalLearned
  const e1 = await mock.handle(FN.START_EXTRA_ROUND, {})
  const e2 = await mock.handle(FN.START_EXTRA_ROUND, {})
  const idem = e1.data.roundId === e2.data.roundId && e2.data.reused === true
  const ef = await mock.handle(FN.FINISH_EXTRA_ROUND, { roundId: e1.data.roundId })
  const settled = ef.data.already === false && ef.data.learnedCount > 0
  const gained = ef.data.totalLearned - base0 === ef.data.learnedCount
  const ef2 = await mock.handle(FN.FINISH_EXTRA_ROUND, { roundId: e1.data.roundId })
  const noDouble = ef2.data.already === true && ef2.data.totalLearned === ef.data.totalLearned
  const homeSynced = (await mock.handle(FN.HOME_SUMMARY, {})).data.totalLearned === ef.data.totalLearned
  console.log(
    `加练体检: 幂等复用=${idem} | 结算 learnedCount=${ef.data.learnedCount} already=${ef.data.already} | ` +
      `计入累计 +${ef.data.totalLearned - base0}(期望 +${ef.data.learnedCount})=${gained} | ` +
      `重复结算不重复计=${noDouble} | 首页同步=${homeSynced}`
  )
  if (!idem || !settled || !gained || !noDouble || !homeSynced) fail++

  // 今日流程必须带 extra（前端「再学一组」按钮靠它决定显隐）
  const tf = await mock.handle(FN.TODAY_FLOW, {})
  const hasExtra = tf.data.extra && typeof tf.data.extra.canStart === 'boolean' && 'exhausted' in tf.data.extra
  console.log(`今日流程 extra 字段: ${hasExtra ? '齐备' : '缺失'}`)
  if (!hasExtra) fail++

  // 句库体检：守住「短句」标准（≤ 18 词）+ 字段完整性
  const lines = mock.getLines()
  const tooLong = lines.filter((q) => q.text.split(/\s+/).length > 18)
  const badField = lines.filter(
    (q) => !q.text || !q.cn || !q.author || !(q.tags && q.tags.length)
  )
  console.log(
    `句库: ${lines.length} 句 | 超 18 词: ${tooLong.length} | 字段缺失: ${badField.length}`
  )
  if (tooLong.length || badField.length) fail++

  // ── 错题本「已掌握」（用户追加）行为体检 ─────────────────────────────
  // 契约：点「已掌握」后该词从错题本消失；重复标记幂等（不再减、不报错）
  const s1 = await mock.handle(FN.STATS, {})
  const target = s1.data.wrongWords[0]
  const d1 = await mock.handle(FN.DISMISS_WRONG, { wordId: target._id })
  const s2 = await mock.handle(FN.STATS, {})
  const gone = !s2.data.wrongWords.some((x) => x._id === target._id)
  const less = s2.data.wrongWords.length === s1.data.wrongWords.length - 1
  const d2 = await mock.handle(FN.DISMISS_WRONG, { wordId: target._id })
  const s3 = await mock.handle(FN.STATS, {})
  const idem2 =
    d2.data.updated === 0 && s3.data.wrongWords.length === s2.data.wrongWords.length
  console.log(
    `错题本体检: 摘掉「${target.word}」→ ${s1.data.wrongWords.length} 减到 ${s2.data.wrongWords.length} 个 | ` +
      `已移除=${gone} 数量-1=${less} | 重复调用幂等=${idem2} (updated=${d1.data.updated}/${d2.data.updated})`
  )
  if (!gone || !less || !idem2) fail++

  // 发音 mock 校验
  const w = mock.audioSrc('abandon', 2, 'word')
  const s = mock.audioSrc('a sentence', 2, 'sentence')
  console.log(`\n发音 mock: 单词→${w ? '有URL' : 'null'} | 例句→${s === null ? 'null(静默)' : '有URL'}`)

  // ⚠️ 汇总必须在**所有**体检之后打印：这四处体检（加练 / extra 字段 / 句库 / 错题本）
  //    此前在汇总行之后执行，失败时退出码是 1、屏幕上却写着「0 failed」，属于误导。
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
