/**
 * finish_extra_round 云函数逻辑自测（node 直跑，零依赖、不连云）
 * 用法：node scripts/test_finish_extra_round.js
 *
 * 为什么单测这个函数：mock 层只是「镜像」，真正的入账逻辑在云函数里，
 * 而它此前没有任何自动化验证。本次改动（加练计入 totalLearned）的风险点全在这里：
 *   ① 该不该加、加多少（口径必须与 finish_checkin 对称）
 *   ② 幂等 —— 重复调用绝不能重复累加（前端重试/连点都会走到）
 *   ③ 别顺手动了 streak / checkins / plan.stage 这些「打卡专属」资产
 *
 * 共享骨架（内存假 DB + wx-server-sdk 桩）见 scripts/_fn_harness.js。
 */
const { dateStr, setStore, getStore, loadFn } = require('./_fn_harness')
const { tester } = require('./_harness')

const main = loadFn('finish_extra_round')

/* ---------------- 本用例的数据集 ---------------- */
function resetStore(opts = {}) {
  setStore({
    users: [
      Object.assign(
        { _id: 'u1', _openid: 'o1', totalLearned: 100, wordCursor: 3, streak: 4 },
        opts.user
      )
    ],
    daily_plans: [
      Object.assign(
        {
          _id: 'p1',
          _openid: 'o1',
          date: dateStr(0),
          newWordIds: ['m1'],
          extraRounds: [
            {
              roundId: 1,
              wordIds: ['a1', 'a2'],
              learnedIds: ['a1', 'a2'],
              practiceQueue: [{ passed: true }, { passed: true }],
              stage: 'practice',
              startedAt: null,
              finishedAt: null
            }
          ]
        },
        opts.plan
      )
    ],
    words: [
      { _id: 'a1', seq: 9, word: 'alpha', audioReady: true },
      { _id: 'a2', seq: 11, word: 'beta', audioReady: true },
      { _id: 'm1', seq: 5, word: 'main', audioReady: true }
    ],
    user_words: [],
    checkins: []
  })
}

const planOf = () => getStore().daily_plans[0]
const userOf = () => getStore().users[0]
const groupOf = () => planOf().extraRounds[0]
const userWords = () => getStore().user_words
const checkins = () => getStore().checkins

const { t, done } = tester()

;(async () => {
  /* ===== 用例 1：首次结算 → 计入累计学习 ===== */
  resetStore()
  const r1 = await main({ roundId: 1 })
  t('首次结算：code=0', r1.code === 0)
  t('首次结算：already=false', r1.data && r1.data.already === false)
  t('首次结算：learnedCount = 本组词数 2', r1.data && r1.data.learnedCount === 2)
  t(
    '首次结算：totalLearned 100 → 102（计入累计学习，D3 已反转）',
    userOf().totalLearned === 102 && r1.data.totalLearned === 102
  )
  t('首次结算：wordCursor 3 → 11（按 max seq 推进，非按词数累加）', userOf().wordCursor === 11)
  t('首次结算：组 stage 置 done', groupOf().stage === 'done')
  t('首次结算：streak 未被改动（加练 ≠ 打卡）', userOf().streak === 4)
  t('首次结算：不产生 checkins', checkins().length === 0)
  t('首次结算：加练词进复习池 2 条', userWords().length === 2)
  t('首次结算：复习日 = 次日', userWords().every((w) => w.nextReviewDate === dateStr(1)))

  /* ===== 用例 2：重复结算 → 幂等，绝不重复累加 ===== */
  resetStore()
  await main({ roundId: 1 })
  const afterFirst = userOf().totalLearned
  const cursorAfterFirst = userOf().wordCursor
  const r2 = await main({ roundId: 1 })
  t('重复结算：already=true', r2.data && r2.data.already === true)
  t(
    `重复结算：totalLearned 仍为 ${afterFirst}（不重复累加）`,
    userOf().totalLearned === afterFirst && r2.data.totalLearned === afterFirst
  )
  t('重复结算：wordCursor 不变', userOf().wordCursor === cursorAfterFirst)
  const r2b = await main({ roundId: 1 })
  t('三连结算：totalLearned 依旧不变', userOf().totalLearned === afterFirst && r2b.code === 0)

  /* ===== 用例 3：练习未全对 → 拒绝，且不计入 ===== */
  resetStore()
  groupOf().practiceQueue = [{ passed: true }, { passed: false }]
  const r3 = await main({ roundId: 1 })
  t('练习未全对：拒绝（code=-1）', r3.code === -1)
  t('练习未全对：totalLearned 不动', userOf().totalLearned === 100)
  t('练习未全对：组 stage 不置 done', groupOf().stage === 'practice')

  /* ===== 用例 4：组不存在 → 拒绝，且不计入 ===== */
  resetStore()
  const r4 = await main({ roundId: 99 })
  t('组不存在：拒绝（code=-1）且不计入', r4.code === -1 && userOf().totalLearned === 100)

  /* ===== 用例 5：边界 —— 空词组不改变任何计数 ===== */
  resetStore()
  groupOf().wordIds = []
  const r5 = await main({ roundId: 1 })
  t(
    '空词组：结算成功但 totalLearned / wordCursor 都不变',
    r5.code === 0 && userOf().totalLearned === 100 && userOf().wordCursor === 3
  )

  /* ===== 用例 6：多组累加（一天 3 组加练）===== */
  resetStore()
  planOf().extraRounds = [1, 2, 3].map((i) => ({
    roundId: i,
    wordIds: ['a' + (i * 2 - 1), 'a' + i * 2],
    learnedIds: [],
    practiceQueue: [{ passed: true }],
    stage: 'practice',
    startedAt: null,
    finishedAt: null
  }))
  getStore().words = [
    { _id: 'a1', seq: 9 },
    { _id: 'a2', seq: 11 },
    { _id: 'a3', seq: 13 },
    { _id: 'a4', seq: 15 },
    { _id: 'a5', seq: 17 },
    { _id: 'a6', seq: 19 }
  ]
  await main({ roundId: 1 })
  await main({ roundId: 2 })
  await main({ roundId: 3 })
  t('三组加练：totalLearned 100 → 106（2×3）', userOf().totalLearned === 106)
  t('三组加练：wordCursor 推进到最大 seq 19', userOf().wordCursor === 19)

  done()
})()
