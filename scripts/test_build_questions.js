/**
 * build_questions 云函数逻辑自测（node 直跑，零依赖、不连云）
 * 用法：node scripts/test_build_questions.js
 *
 * 为什么单测这个函数：它是**判题契约**的产生处。改为「本地同步判题」后，
 * 前端能不能立即出对错，完全取决于它有没有把 `answerIndex` / `audioText` 下发。
 * 而这类改错**不会报错**：前端会静默走「降级路径」（题不带答案 → 回退云函数判题），
 * 功能正常只是慢 —— 只有这个测试能当场抓住。
 *
 * 三个必须钉住的点：
 *   ① `answerIndex` 真的下发了，且指向的确实是正确选项（不是随便一个数字）；
 *   ② `audioText` 是**该读的英文**，并且**绝不含中文** ——
 *      判据若写成「看 phonetic 是否为空」，没音标的 cn_option 会把中文释义当英文词下发；
 *   ③ 复用分支（plan 里已有 queue）同样带这两个字段 —— 老数据里本来就有 answerIndex，
 *      别忘了复用路径。
 *
 * 共享骨架（内存假 DB + wx-server-sdk 桩）见 scripts/_fn_harness.js。
 */
const { dateStr, setStore, getStore, loadFn } = require('./_fn_harness')
const { tester } = require('./_harness')

const main = loadFn('build_questions')

/* 待学词（注意题型按 i%2 交替，**第 1 个词是 cn_option**）：
   w1 刻意不给音标 —— 用来钉住 audioText 的判据必须是 type 而不是 phonetic
   w2 带 roots / w1、w3 不带 —— 覆盖「有词根透传 / 无词根兜底空数组」两态（D15） */
const TARGETS = [
  { _id: 'w1', seq: 1, word: 'dwell', phoneticUS: '', meaning: '居住；细想' },
  { _id: 'w2', seq: 2, word: 'abandon', phoneticUS: '/əˈbændən/', meaning: '放弃；抛弃',
    roots: [
      { part: 'ab-', type: '前缀', meaning: '离开' },
      { part: 'bandon', type: '词根', meaning: '控制；命令' }
    ] },
  { _id: 'w3', seq: 3, word: 'withstand', phoneticUS: '/wɪðˈstænd/', meaning: '承受；抵住' }
]
const POOL = [
  { _id: 'p1', seq: 9, word: 'ignore', meaning: '忽略' },
  { _id: 'p2', seq: 10, word: 'maintain', meaning: '维持' },
  { _id: 'p3', seq: 11, word: 'reject', meaning: '拒绝' },
  { _id: 'p4', seq: 12, word: 'pursue', meaning: '追求' },
  { _id: 'p5', seq: 13, word: 'revise', meaning: '修订' }
]

function resetStore(opts = {}) {
  setStore({
    daily_plans: [
      Object.assign(
        { _id: 'p1', _openid: 'o1', date: dateStr(0), newWordIds: TARGETS.map((w) => w._id) },
        opts.plan
      )
    ],
    words: opts.words || TARGETS.concat(POOL)
  })
}

const CN = /[\u4e00-\u9fa5]/
const EN_ONLY = /^[a-zA-Z][a-zA-Z' -]*$/
const byType = (qs, type) => qs.filter((q) => q.type === type)
const wordOf = (id) => TARGETS.filter((w) => w._id === id)[0] || {}

const { t, done } = tester()

;(async () => {
  /* ===== 用例 1：答案随题目下发（本次改动的核心）===== */
  resetStore()
  const r = await main({ phase: 'practice' })
  const qs = (r.data || {}).questions || []
  t('code=0，题数 = 当日新词数（3）', r.code === 0 && qs.length === 3)
  t('★ 每道题都下发 answerIndex（前端靠它本地判题）',
    qs.every((q) => typeof q.answerIndex === 'number' && q.answerIndex >= 0))
  t('★ answerIndex 必须落在选项范围内', qs.every((q) => q.answerIndex < q.options.length))

  /* ===== 用例 2：answerIndex 指向的确实是正确答案 ===== */
  const cnQs = byType(qs, 'cn_option')
  const enQs = byType(qs, 'en_option')
  t('两种题型都出现（i%2 交替：3 题 → 2 个中选英 + 1 个英选中）',
    cnQs.length === 2 && enQs.length === 1)
  t('cn_option：answerIndex 指向的是该词的中文释义',
    cnQs.every((q) => q.options[q.answerIndex] === wordOf(q.wordId).meaning))
  t('en_option：answerIndex 指向的是该词的英文拼写',
    enQs.every((q) => q.options[q.answerIndex] === wordOf(q.wordId).word))
  t('cn_option：题干是英文单词', cnQs.every((q) => q.stem === wordOf(q.wordId).word))
  t('en_option：题干是中文释义', enQs.every((q) => q.stem === wordOf(q.wordId).meaning))

  /* ===== 用例 2b：roots —— 词根拆解随题下发（D15）===== */
  t('★ 每道题都下发 roots 字段（练习页题干区展示词根用）',
    qs.every((q) => Array.isArray(q.roots)))
  t('★ roots 原样来自 words.roots（part/type/meaning 三件套齐全）',
    cnQs.concat(enQs).every((q) => {
      const w = wordOf(q.wordId)
      const expect = w.roots || []
      return q.roots.length === expect.length &&
        q.roots.every((r, i) => r.part === expect[i].part && r.meaning === expect[i].meaning)
    }))

  /* ===== 用例 3：audioText —— 答对后要读的英文 ===== */
  t('★ 每道题都下发 audioText', qs.every((q) => typeof q.audioText === 'string' && q.audioText))
  t('★ audioText 一律是纯英文（绝不能把中文释义当词去查音频）',
    qs.every((q) => !CN.test(q.audioText) && EN_ONLY.test(q.audioText)))
  t('cn_option：audioText = 题干英文词', cnQs.every((q) => q.audioText === q.stem))
  t('en_option：audioText = 正确选项英文词', enQs.every((q) => q.audioText === q.options[q.answerIndex]))
  const noPhoneticCn = cnQs.filter((q) => q.wordId === 'w1')[0]
  t('★ 没有音标的 cn_option 也要给出英文 audioText（判据是 type，不是 phonetic）',
    !!noPhoneticCn && noPhoneticCn.phonetic === '' && noPhoneticCn.audioText === 'dwell')

  /* ===== 用例 4：干扰项来自非本批词库 ===== */
  const targetIds = TARGETS.map((w) => w._id)
  t('干扰项不来自本批待学词（4 个选项里只有 1 个是本批的）',
    qs.every((q) => {
      const meanings = q.options.map((o) => o)
      const fromBatch = targetIds.filter((id) => {
        const w = wordOf(id)
        return meanings.indexOf(q.type === 'cn_option' ? w.meaning : w.word) >= 0
      })
      return fromBatch.length === 1 && q.options.length === 4
    }))

  /* ===== 用例 5：复用分支（plan 里已有 queue）同样带答案 ===== */
  resetStore({ plan: { practiceQueue: [
    { id: 'w1_0', wordId: 'w1', type: 'cn_option', stem: 'abandon', phonetic: '/x/', options: ['放弃；抛弃', '忽略', '维持', '拒绝'], answerIndex: 0, passed: false, wrong: false }
  ] } })
  const r2 = await main({ phase: 'practice' })
  const rq = (r2.data || {}).questions || []
  t('复用已有队列：reused=true', r2.code === 0 && r2.data.reused === true)
  t('★ 复用分支也带 answerIndex（老数据里本来就有，别在复用路径漏掉）',
    rq.length === 1 && rq[0].answerIndex === 0)
  t('★ 复用分支也带 audioText（否则老队列答对后不发声）',
    rq[0].audioText === 'abandon')
  t('复用分支不把服务端字段漏出去（passed / wrong 不下发）',
    rq[0].passed === undefined && rq[0].wrong === undefined)
  t('★ 复用分支的旧题没有 roots → 兜底 []（D15 前生成的队列，前端据此不渲染词根区）',
    Array.isArray(rq[0].roots) && rq[0].roots.length === 0)

  /* ===== 用例 6：加练组（round 路由）===== */
  resetStore({ plan: { newWordIds: [], extraRounds: [
    { roundId: 2, wordIds: ['w1'], learnedIds: [], practiceQueue: [], stage: 'learning' }
  ] } })
  const r3 = await main({ phase: 'practice', round: 2 })
  t('round>0：读的是该加练组的词（1 题）', r3.code === 0 && r3.data.questions.length === 1)
  const q3 = r3.data.questions[0] || {}
  t('round>0：题目同样带答案（answerIndex 指向正确释义）',
    typeof q3.answerIndex === 'number' && q3.options[q3.answerIndex] === wordOf('w1').meaning)
  t('round>0：题目同样带 audioText', q3.audioText === 'dwell')
  t('round>0：写回组内队列而不是主练习队列',
    (getStore().daily_plans[0].extraRounds[0].practiceQueue || []).length === 1 &&
      getStore().daily_plans[0].practiceQueue === undefined)

  const r3b = await main({ phase: 'practice', round: 9 })
  t('round 指向不存在的加练组：拒绝', r3b.code === -1)

  /* ===== 用例 7：边界 ===== */
  resetStore({ plan: { newWordIds: [] } })
  const r4 = await main({ phase: 'practice' })
  t('当日无新词：返回空题组（不报错）', r4.code === 0 && r4.data.questions.length === 0)

  resetStore({ plan: { date: '1999-01-01' } })
  const r5 = await main({ phase: 'practice' })
  t('当日 plan 不存在：拒绝', r5.code === -1)

  done()
})()
