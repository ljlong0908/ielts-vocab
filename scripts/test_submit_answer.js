/**
 * submit_answer 云函数逻辑自测（node 直跑，零依赖、不连云）
 * 用法：node scripts/test_submit_answer.js
 *
 * 为什么单测这个函数：它虽已退化为「后台落库」，但正确率 / 错题本 / **复习调度** /
 * plan.stage 全靠它写，且此前没有任何自动化验证。本测试重点钉四件事：
 *   ① user_words 复习状态推进（review 阶段答对/答错的 clean 判定，spec §7.4）
 *   ② R6（2026-10-13 用户拍板「仅昨日新词、错词次日不再自动复习」）：复习是
 *      一轮一次性测验 —— clean → mastered；否则出池（status='reviewed'、
 *      nextReviewDate=''）；任何阶段答错都不再写「次日报到」
 *   ③ R2：**新词首次答错也必须留下 wrongCount** —— 否则 finish_checkin 统一按
 *      wrongCount:0 注册，次日复习的 clean 判定失真
 *   ④ 队列路由（round>0 只写组内，绝不顶掉 plan.stage —— C3）
 *
 * 共享骨架（内存假 DB + wx-server-sdk 桩）见 scripts/_fn_harness.js。
 */
const { dateStr, setStore, getStore, loadFn } = require('./_fn_harness')
const { tester } = require('./_harness')

const main = loadFn('submit_answer')
const finishCheckin = loadFn('finish_checkin')

/* ---------------- 本用例的数据集 ---------------- */
function resetStore(opts = {}) {
  setStore({
    users: [
      Object.assign(
        { _id: 'u1', _openid: 'o1', totalLearned: 10, wordCursor: 0, streak: 2, lastCheckinDate: '' },
        opts.user
      )
    ],
    daily_plans: [
      Object.assign(
        {
          _id: 'p1',
          _openid: 'o1',
          date: dateStr(0),
          newWordIds: ['m1', 'm2'],
          learnedIds: ['m1', 'm2'],
          reviewWordIds: ['r1'],
          reviewQueue: [
            { id: 'r1_0', wordId: 'r1', type: 'cn_option', answerIndex: 1, passed: false, wrong: false }
          ],
          practiceQueue: [
            { id: 'm1_0', wordId: 'm1', type: 'cn_option', answerIndex: 1, passed: false, wrong: false },
            { id: 'm2_1', wordId: 'm2', type: 'en_option', answerIndex: 0, passed: false, wrong: false }
          ],
          stage: 'practice'
        },
        opts.plan
      )
    ],
    words: [
      { _id: 'm1', seq: 5, word: 'abandon', audioReady: true },
      { _id: 'm2', seq: 6, word: 'dwell', audioReady: true },
      { _id: 'r1', seq: 3, word: 'acknowledge', audioReady: true }
    ],
    user_words: [],
    records: [],
    checkins: []
  })
}

const planOf = () => getStore().daily_plans[0]
const userWords = () => getStore().user_words
const records = () => getStore().records
const uwOf = (wordId) => getStore().user_words.filter((w) => w.wordId === wordId)[0]

const { t, done } = tester()

;(async () => {
  /* ===== 用例 1：review 阶段答对且 clean（本轮无错 + 历史无错）→ 直接 mastered ===== */
  resetStore()
  getStore().user_words = [
    { _id: 'uw1', _openid: 'o1', wordId: 'r1', status: 'reviewing', round: 1, wrongCount: 0, nextReviewDate: dateStr(0) }
  ]
  const r1 = await main({ phase: 'review', questionIndex: 0, choice: 1 })
  t('review 答对 clean：code=0', r1.code === 0)
  t('review 答对 clean：status=mastered', uwOf('r1').status === 'mastered')
  t('review 答对 clean：nextReviewDate 清空（双保险之一，status 是其二）', uwOf('r1').nextReviewDate === '')
  t('review 答对 clean：round 1 → 2', uwOf('r1').round === 2)
  t('review 答对 clean：lastReviewDate=今天', uwOf('r1').lastReviewDate === dateStr(0))

  /* ===== 用例 2：review 阶段本轮答错过再答对 → 不毕业、出池（q.wrong 持久在 queue 文档里）===== */
  resetStore()
  getStore().user_words = [
    { _id: 'uw1', _openid: 'o1', wordId: 'r1', status: 'reviewing', round: 1, wrongCount: 0, nextReviewDate: dateStr(0) }
  ]
  planOf().reviewQueue[0].wrong = true
  await main({ phase: 'review', questionIndex: 0, choice: 0 }) // 先答错
  await main({ phase: 'review', questionIndex: 0, choice: 1 }) // 再答对
  t('review 本轮答错过：答对也不 mastered（R6：出池，不次日复习）', uwOf('r1').status === 'reviewed')
  t('review 本轮答错过：nextReviewDate 清空（出池即终态）', uwOf('r1').nextReviewDate === '')
  t('review 本轮答错过：wrongCount 0 → 1', uwOf('r1').wrongCount === 1)

  /* ===== 用例 3：review 阶段历史 wrongCount>0 → 一轮答对也不毕业 ===== */
  resetStore()
  getStore().user_words = [
    { _id: 'uw1', _openid: 'o1', wordId: 'r1', status: 'reviewing', round: 2, wrongCount: 3, nextReviewDate: dateStr(0) }
  ]
  await main({ phase: 'review', questionIndex: 0, choice: 1 })
  t('review 历史有错：一轮答对也不 mastered（spec §7.4 clean 判定）', uwOf('r1').status === 'reviewed')
  t('review 历史有错：nextReviewDate 清空（R6：错词不次日复习）', uwOf('r1').nextReviewDate === '')

  /* ===== 用例 4：review 阶段答错 → wrongCount+1、出池（不再次日报到）===== */
  resetStore()
  getStore().user_words = [
    { _id: 'uw1', _openid: 'o1', wordId: 'r1', status: 'reviewing', round: 1, wrongCount: 1, nextReviewDate: dateStr(0) }
  ]
  await main({ phase: 'review', questionIndex: 0, choice: 0 })
  t('review 答错：wrongCount 1 → 2', uwOf('r1').wrongCount === 2)
  t('review 答错：status=reviewed、nextReviewDate 清空（R6：答错即出池）',
    uwOf('r1').status === 'reviewed' && uwOf('r1').nextReviewDate === '')
  t('review 答错：queue 标记 wrong=true', planOf().reviewQueue[0].wrong === true)

  /* ===== 用例 5（R2）：practice 阶段新词首次答错 → 落一条只带 wrongCount 的记录 ===== */
  resetStore()
  const r5 = await main({ phase: 'practice', questionIndex: 0, choice: 0 })
  t('practice 新词答错：code=0', r5.code === 0)
  t('practice 新词答错：user_words 落 1 条记录', userWords().length === 1)
  t('practice 新词答错：wrongCount=1（R2 核心：昨天练习答的错要留下）', uwOf('m1').wrongCount === 1)
  t('practice 新词答错：不写 status（$lte 不匹配字段缺失 → 不会提前进复习集合）',
    uwOf('m1').status === undefined)
  t('practice 新词答错：不写 nextReviewDate（没打卡就走「次日重学」，不是「次日复习」）',
    uwOf('m1').nextReviewDate === undefined)
  t('practice 新词答错：records 照写（错题本数据源）', records().length === 1 && records()[0].isCorrect === false)

  /* ===== 用例 6（R2+R6）：practice 阶段答错且 uw 已存在（重学场景）→ wrongCount 累加 + 出池 ===== */
  resetStore()
  getStore().user_words = [
    { _id: 'uw9', _openid: 'o1', wordId: 'm1', wrongCount: 1 } // 昨天答错留下的半条记录
  ]
  await main({ phase: 'practice', questionIndex: 0, choice: 0 })
  t('practice 重学再答错：wrongCount 1 → 2（累加不清零）', uwOf('m1').wrongCount === 2)
  t('practice 重学再答错：R6 出池（status=reviewed、nextReviewDate 清空）',
    uwOf('m1').status === 'reviewed' && uwOf('m1').nextReviewDate === '')

  /* ===== 用例 7（R2）：practice 阶段答对且 uw 不存在 → 不写 user_words ===== */
  resetStore()
  await main({ phase: 'practice', questionIndex: 0, choice: 1 })
  t('practice 新词答对：不建 user_words（注册归 finish_checkin，避免半程入池）', userWords().length === 0)
  t('practice 新词答对：queue 标记 passed=true', planOf().practiceQueue[0].passed === true)

  /* ===== 用例 8（R2 联动闭环）：昨日答错 → 打卡注册 → 次日复习一轮答对应「仍 review」===== */
  resetStore()
  await main({ phase: 'practice', questionIndex: 0, choice: 0 }) // 昨天练习答错（uw 不存在路径）
  // 昨晚最终全部答对才打卡（m1 是答错过又答对的，queue 上 wrong+passed 并存）
  planOf().practiceQueue.forEach((q) => { q.passed = true })
  const ck = await finishCheckin({}) // 昨天正常打卡
  t('联动：打卡成功', ck.code === 0)
  t('联动：打卡把调度字段补上（status=reviewing、次日复习）',
    uwOf('m1').status === 'reviewing' && uwOf('m1').nextReviewDate === dateStr(1))
  t('联动：打卡不覆盖 wrongCount（R2 的隐式契约，finish_checkin 那边已注释钉住）',
    uwOf('m1').wrongCount === 1)
  // 今天：该词进复习集合，一轮答对
  getStore().daily_plans[0].reviewWordIds = ['m1']
  getStore().daily_plans[0].reviewQueue = [
    { id: 'm1_r', wordId: 'm1', type: 'cn_option', answerIndex: 1, passed: false, wrong: false }
  ]
  await main({ phase: 'review', questionIndex: 0, choice: 1 })
  t('联动：次日一轮答对 → 因历史有错出池 reviewed（修复前会误判 mastered）',
    uwOf('m1').status === 'reviewed' && uwOf('m1').nextReviewDate === '')

  /* ===== 用例 9：stage 推进 —— reviewQueue 全对 → learning；practiceQueue 全对 → practice_done ===== */
  resetStore()
  await main({ phase: 'review', questionIndex: 0, choice: 1 })
  t('reviewQueue 全对：stage → learning', planOf().stage === 'learning')
  resetStore()
  await main({ phase: 'practice', questionIndex: 0, choice: 1 })
  t('practiceQueue 未全对：stage 不动', planOf().stage === 'practice')
  await main({ phase: 'practice', questionIndex: 1, choice: 0 })
  t('practiceQueue 全对：stage → practice_done', planOf().stage === 'practice_done')

  /* ===== 用例 10：round>0 → 只写组内队列与组 stage，plan.stage 绝不被动（C3）===== */
  resetStore()
  planOf().extraRounds = [
    {
      roundId: 3,
      wordIds: ['m1'],
      learnedIds: ['m1'],
      practiceQueue: [{ id: 'm1_0', wordId: 'm1', type: 'cn_option', answerIndex: 1, passed: false, wrong: false }],
      stage: 'learning'
    }
  ]
  await main({ phase: 'practice', questionIndex: 0, choice: 1, round: 3 })
  t('加练：组内 queue 标记 passed', planOf().extraRounds[0].practiceQueue[0].passed === true)
  t('加练：组 stage → practice_done', planOf().extraRounds[0].stage === 'practice_done')
  t('加练：plan.stage 仍是 practice（主流程状态机不被顶掉）', planOf().stage === 'practice')
  t('加练：不写主 practiceQueue', planOf().practiceQueue.every((q) => !q.passed))

  /* ===== 用例 11：题目不存在 / plan 不存在 → 拒绝且不写任何东西 ===== */
  resetStore()
  const r11 = await main({ phase: 'practice', questionIndex: 99, choice: 0 })
  t('题目不存在：code=-1', r11.code === -1)
  t('题目不存在：不写 records', records().length === 0)
  t('题目不存在：不写 user_words', userWords().length === 0)

  done()
})()
