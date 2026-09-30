/**
 * start_extra_round 云函数逻辑自测（node 直跑，零依赖、不连云）
 * 用法：node scripts/test_start_extra_round.js
 *
 * 为什么单测这个函数：它是「选词 + 幂等复用」的实现处，此前**没有任何自动化验证**。
 * 本次改动（每日上限取消 → 不限次数）正好落在这里，风险点：
 *   ① 上限真的不生效了吗（第 4 组、第 10 组还能不能开）
 *   ② 幂等 —— 有未完成的组必须原样复用，连点两次不能建两组
 *   ③ 选词不能重复：必须排除当日 newWordIds 与所有已出过的加练词
 *   ④ ⛔ 绝不推进 wordCursor（游标只在「结算」时推进，否则中途退出的词次日会被跳过）
 *
 * 共享骨架（内存假 DB + wx-server-sdk 桩）见 scripts/_fn_harness.js。
 */
const { dateStr, setStore, getStore, loadFn } = require('./_fn_harness')
const { tester } = require('./_harness')

const main = loadFn('start_extra_round')

const GOAL = 5

/* ---------------- 本用例的数据集 ---------------- */
function resetStore(opts = {}) {
  setStore({
    users: [
      Object.assign(
        { _id: 'u1', _openid: 'o1', dailyGoal: GOAL, wordCursor: 0, totalLearned: 100 },
        opts.user
      )
    ],
    daily_plans: [
      Object.assign({ _id: 'p1', _openid: 'o1', date: dateStr(0), newWordIds: [], extraRounds: [] }, opts.plan)
    ],
    // seq 连续，确保 orderBy('seq','asc') 取到的是 a1..aN
    words:
      opts.words ||
      Array.from({ length: 20 }, (_, i) => ({
        _id: 'a' + (i + 1),
        seq: i + 1,
        word: 'w' + (i + 1),
        audioReady: true
      })),
    checkins: opts.noCheckin ? [] : [{ _id: 'c1', _openid: 'o1', date: dateStr(0) }]
  })
}

const planOf = () => getStore().daily_plans[0]
const userOf = () => getStore().users[0]
const rounds = () => planOf().extraRounds || []

const { t, done } = tester()

;(async () => {
  /* ===== 用例 1：首次发起 ===== */
  resetStore()
  const r1 = await main()
  t('首次发起：code=0 且不是复用', r1.code === 0 && r1.data.reused === false)
  t('首次发起：roundId=1', r1.data.roundId === 1)
  t('首次发起：取满 dailyGoal 个词（5）', r1.data.wordIds.length === GOAL)
  t('首次发起：按 seq 升序取（a1..a5）', r1.data.wordIds.join(',') === 'a1,a2,a3,a4,a5')
  t('首次发起：组写回 plan 且 stage=learning', rounds().length === 1 && rounds()[0].stage === 'learning')
  t('首次发起：learnedIds / practiceQueue 初始为空',
    rounds()[0].learnedIds.length === 0 && rounds()[0].practiceQueue.length === 0)

  /* ===== 用例 2：⛔ 绝不推进 wordCursor（只在结算时推进）===== */
  t('发起加练不推进 wordCursor（否则中途退出的词次日会被跳过）', userOf().wordCursor === 0)
  t('发起加练不改 totalLearned（只在结算时入账）', userOf().totalLearned === 100)

  /* ===== 用例 3：幂等 —— 有未完成的组就复用，不新建 ===== */
  resetStore()
  const a1 = await main()
  const a2 = await main()
  t('幂等：第二次发起的 roundId 与第一次相同', a2.data.roundId === a1.data.roundId)
  t('幂等：第二次 reused=true', a2.data.reused === true)
  t('幂等：plan 里仍然只有 1 组（连点两次没建两组）', rounds().length === 1)

  /* ===== 用例 4：★ 每日上限已取消（本次改动的核心）===== */
  resetStore()
  for (let i = 1; i <= 3; i++)
    planOf().extraRounds.push({
      roundId: i,
      wordIds: ['a' + i],
      learnedIds: [],
      practiceQueue: [],
      stage: 'done'
    })
  const r4 = await main()
  t('★ 已有 3 组（全部 done）→ 仍能创建第 4 组', r4.code === 0 && r4.data.roundId === 4)
  t('★ 第 4 组 stage=learning 且已写回', rounds().length === 4 && rounds()[3].stage === 'learning')

  resetStore()
  for (let i = 1; i <= 10; i++)
    planOf().extraRounds.push({
      roundId: i,
      wordIds: ['a' + i],
      learnedIds: [],
      practiceQueue: [],
      stage: 'done'
    })
  const r4b = await main()
  t('★ 已有 10 组 → 第 11 组照样能开（不限次数）', r4b.code === 0 && r4b.data.roundId === 11)

  /* ===== 用例 5：前置校验 ===== */
  resetStore({ noCheckin: true })
  const r5 = await main()
  t('未打卡：拒绝（D1=A），且提示引导去打卡', r5.code === -1 && /打卡/.test(r5.message || ''))

  resetStore({ plan: { date: '1999-01-01' } })
  const r5b = await main()
  t('当日 plan 不存在：拒绝', r5b.code === -1)

  /* ===== 用例 6：选词排除当日新词与已出过的加练词 ===== */
  resetStore({
    plan: {
      newWordIds: ['m1'],
      extraRounds: [{ roundId: 1, wordIds: ['a1'], learnedIds: [], practiceQueue: [], stage: 'done' }]
    },
    user: { wordCursor: 0 },
    words: [
      { _id: 'm1', seq: 1, audioReady: true },
      { _id: 'a1', seq: 2, audioReady: true },
      { _id: 'a2', seq: 3, audioReady: true },
      { _id: 'a3', seq: 4, audioReady: true },
      { _id: 'a4', seq: 5, audioReady: true },
      { _id: 'a5', seq: 6, audioReady: true },
      { _id: 'a6', seq: 7, audioReady: true }
    ]
  })
  const r6 = await main()
  t('选词：排除当日 newWordIds（m1）与已出过的加练词（a1）',
    r6.data.wordIds.join(',') === 'a2,a3,a4,a5,a6')

  /* ===== 用例 7：游标之后的词不够 / 完全没有 → exhausted ===== */
  resetStore({ user: { wordCursor: 18 } })
  const r7 = await main()
  t('词池只剩 2 个（a19/a20）→ 有多少给多少，不算取尽',
    r7.code === 0 && r7.data.wordIds.length === 2 && r7.data.exhausted === false)

  resetStore({ user: { wordCursor: 999 } })
  const r7b = await main()
  t('游标之后无可出词 → exhausted=true', r7b.code === 0 && r7b.data.exhausted === true)
  t('取尽时不创建空组（roundId=null，plan 里没有新组）',
    r7b.data.roundId === null && rounds().length === 0)

  /* ===== 用例 8：未点亮音频的词不出（硬约束 seq>cursor 且 audioReady）===== */
  resetStore({
    words: [
      { _id: 'x1', seq: 1, audioReady: true },
      { _id: 'x2', seq: 2, audioReady: false },
      { _id: 'x3', seq: 3, audioReady: true }
    ]
  })
  const r8 = await main()
  t('audioReady=false 的词永不出（只给已就绪的）', r8.data.wordIds.join(',') === 'x1,x3')

  done()
})()
