/**
 * today_flow 云函数逻辑自测（node 直跑，零依赖、不连云）
 * 用法：node scripts/test_today_flow.js
 *
 * 为什么单测这个函数：它是「前端唯一状态来源」，此前没有任何自动化验证。
 * 本测试聚焦三处：
 *   ① R4（2026-10-13）：到期查询必须 `orderBy('nextReviewDate','asc')` ——
 *      无排序时 limit(50) 按数据库自然序截断，断档积压时靠后的词天天取不到，队尾饿死
 *   ② R6（2026-10-13）：到期查询必须**正相匹配** `status:'reviewing'` ——
 *      用 `_.neq('mastered')` 会把复习出池的终态 'reviewed' 捞回池里，
 *      「错词次日不再自动复习」被悄悄破坏（且没有任何报错）
 *   ③ markLearned 的 round 路由（C2）：加练的 learnedIds 写进组内，
 *      写进主 learnedIds 会让首页「今日进度」虚涨
 * 顺带守护建 plan 的幂等 / mastered 排除 / 打卡强改 done（不落库）。
 *
 * 共享骨架（内存假 DB + wx-server-sdk 桩）见 scripts/_fn_harness.js。
 */
const { dateStr, setStore, getStore, loadFn } = require('./_fn_harness')
const { tester } = require('./_harness')

const main = loadFn('today_flow')

/* ---------------- 本用例的数据集 ---------------- */
function resetStore(opts = {}) {
  const store = {
    users: [
      Object.assign(
        { _id: 'u1', _openid: 'o1', dailyGoal: 5, streak: 3, lastCheckinDate: dateStr(-1), totalLearned: 42, wordCursor: 10 },
        opts.user
      )
    ],
    // 默认**无**当日 plan（today_flow 的建 plan 路径）；需要「已存在」的用例显式传
    daily_plans: opts.plan ? [Object.assign({ _id: 'p1', _openid: 'o1', date: dateStr(0) }, opts.plan)] : [],
    user_words: opts.userWords || [],
    words: opts.words || [
      { _id: 'a1', seq: 11, audioReady: true },
      { _id: 'a2', seq: 12, audioReady: true }
    ],
    checkins: opts.checkins || []
  }
  setStore(store)
}

const planOf = () => getStore().daily_plans[0]
const userWords = () => getStore().user_words
/** 造 N 条**全部到期**的词，nextReviewDate 从 N 天前排到昨天，乱序插入 */
function pendingWords(n) {
  const rows = []
  for (let i = 0; i < n; i++) {
    rows.push({
      _id: 'uw' + i,
      _openid: 'o1',
      wordId: 'w' + i,
      status: 'reviewing',
      nextReviewDate: dateStr(-(n - i))
    })
  }
  // 乱序：偶数位插到头部 —— 自然序（插入序）与日期序不一致，orderBy 断言才有效
  return rows.sort(() => Math.random() - 0.5)
}

const { t, done } = tester()

;(async () => {
  /* ===== 用例 1（R4）：到期超 50 条 → 取最老的 50 条，且按复习日升序 ===== */
  resetStore({ userWords: pendingWords(60) })
  const r1 = await main({})
  t('R4：建当日 plan', r1.code === 0 && planOf().date === dateStr(0))
  t('R4：reviewWordIds 截到 50 条', planOf().reviewWordIds.length === 50)
  const dates = planOf().reviewWordIds.map((id) => {
    const uw = userWords().filter((w) => w.wordId === id)[0]
    return uw.nextReviewDate
  })
  t('R4：取的是**最老**的 50 条（无排序会按自然序截断，队尾饿死）',
    dates[0] === dateStr(-60) && dates[49] === dateStr(-11))
  t('R4：50 条按 nextReviewDate 升序（最老先复习）',
    dates.every((d, i) => i === 0 || dates[i - 1] <= d))
  t('R4：被截断的第 51 条确实比入选的第 50 条新',
    userWords().filter((w) => !planOf().reviewWordIds.includes(w.wordId)).every((w) => w.nextReviewDate > dates[49]))
  t('R4：有到期词 → stage=review', planOf().stage === 'review')

  /* ===== 用例 2： mastered / reviewed 出池 / 未来日期 / 字段缺失 → 不进到期集合 ===== */
  resetStore({
    userWords: [
      { _id: 'x1', _openid: 'o1', wordId: 'm', status: 'mastered', nextReviewDate: dateStr(-3) },
      { _id: 'x2', _openid: 'o1', wordId: 'f', status: 'reviewing', nextReviewDate: dateStr(1) },
      { _id: 'x3', _openid: 'o1', wordId: 'n', status: 'reviewing' },
      { _id: 'x5', _openid: 'o1', wordId: 'd', status: 'reviewed', nextReviewDate: dateStr(-1) },
      { _id: 'x4', _openid: 'o1', wordId: 'ok', status: 'reviewing', nextReviewDate: dateStr(-1) }
    ]
  })
  await main({})
  t('到期集合：mastered 排除（即使 nextReviewDate 已过期）', !planOf().reviewWordIds.includes('m'))
  t('R6：reviewed 出池终态排除（用 _.neq(mastered) 会把它捞回来）', !planOf().reviewWordIds.includes('d'))
  t('到期集合：未来复习日排除', !planOf().reviewWordIds.includes('f'))
  t('到期集合：nextReviewDate 字段缺失排除（$lte 不匹配缺失）', !planOf().reviewWordIds.includes('n'))
  t('到期集合：真正到期的进集合', planOf().reviewWordIds.join() === 'ok')

  /* ===== 用例 3：无到期词 → stage=learning ===== */
  resetStore({ userWords: [] })
  await main({})
  t('无到期词：stage=learning', planOf().stage === 'learning')

  /* ===== 用例 4：当日 plan 已存在 → 不重建（幂等）===== */
  resetStore({
    userWords: pendingWords(3),
    plan: { reviewWordIds: ['only'], newWordIds: [], stage: 'review', createdAt: new Date() }
  })
  await main({})
  t('已存在 plan：不重算 reviewWordIds（当天的集合是早上快照）', planOf().reviewWordIds.join() === 'only')

  /* ===== 用例 5：今日已打卡 → stage 强制 done，但**不落库** ===== */
  resetStore({
    userWords: [],
    checkins: [{ _id: 'c1', _openid: 'o1', date: dateStr(0) }]
  })
  const r5 = await main({})
  t('已打卡：返回的 stage=done（首页文案走「今日已完成」）', r5.data.plan.stage === 'done')
  t('已打卡：store 里仍是 learning（只改内存，保持状态机可追溯）', planOf().stage === 'learning')

  /* ===== 用例 6：markLearned round=0 → 写主 learnedIds ===== */
  resetStore({ plan: { reviewWordIds: [], newWordIds: ['w1', 'w2'], learnedIds: ['w1'], stage: 'learning' } })
  await main({ action: 'markLearned', wordId: 'w2', round: 0 })
  t('markLearned 主流程：learnedIds 累加', planOf().learnedIds.join() === 'w1,w2')

  /* ===== 用例 7（C2）：markLearned round>0 → 只写组内，主 learnedIds 不动 ===== */
  resetStore({
    plan: {
      reviewWordIds: [],
      newWordIds: ['w1'],
      learnedIds: ['w1'],
      stage: 'learning',
      extraRounds: [{ roundId: 4, wordIds: ['e1', 'e2'], learnedIds: [], stage: 'learning' }]
    }
  })
  await main({ action: 'markLearned', wordId: 'e1', round: 4 })
  t('C2：加练 learnedIds 写进组内', planOf().extraRounds[0].learnedIds.join() === 'e1')
  t('C2：主 learnedIds 不被加练污染（否则首页今日进度虚涨）', planOf().learnedIds.join() === 'w1')

  /* ===== 用例 8：extra 聚合 —— 未打卡不可加练 / 已打卡且词池有剩可加练 ===== */
  resetStore({ userWords: [], checkins: [] })
  const r8 = await main({})
  t('extra：未打卡 → canStart=false（D1=A：仅打卡后可加练）', r8.data.extra.canStart === false)
  resetStore({ userWords: [], checkins: [{ _id: 'c1', _openid: 'o1', date: dateStr(0) }] })
  const r8b = await main({})
  t('extra：已打卡且词池有剩 → canStart=true', r8b.data.extra.canStart === true)
  t('extra：无未完成组 → pendingRound=null', r8b.data.extra.pendingRound === null)

  /* ===== 用例 9：extra 聚合 —— 有未完成组 → pendingRound 指向它 ===== */
  resetStore({
    userWords: [],
    checkins: [{ _id: 'c1', _openid: 'o1', date: dateStr(0) }],
    plan: {
      reviewWordIds: [],
      newWordIds: [],
      stage: 'done',
      extraRounds: [
        { roundId: 4, wordIds: ['e1'], learnedIds: ['e1'], stage: 'done' },
        { roundId: 5, wordIds: ['e2'], learnedIds: [], stage: 'learning' }
      ]
    }
  })
  const r9 = await main({})
  t('extra：未完成组 → pendingRound.roundId=5（首页显示「继续学一组」）',
    r9.data.extra.pendingRound && r9.data.extra.pendingRound.roundId === 5)
  t('extra：下发的 extraRounds 剥掉了 practiceQueue（答案不随 plan 泄露）',
    r9.data.plan.extraRounds.every((g) => !('practiceQueue' in g)))

  done()
})()
