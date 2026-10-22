/**
 * submit_answer —— 后台落库 + 复习状态推进
 *
 * ⚠️ 前端已用题目自带的 `answerIndex` 本地判过对错（见 §7.5），**不再等这个函数的回包**。
 *    这里仍然自己判一次（不信客户端），但职责已退化为：
 *      写 records → 推进 user_words 复习状态 → 推进 queue 的 passed / plan.stage。
 *    因此它的**时序**有意义而**返回值**基本没人用：
 *      · 前端把提交串行化（并发会互相覆盖 queue，见 practice.js syncAnswer）；
 *      · 跳转前会 await 排空（finish_checkin 的前置是「queue 全 passed」）。
 *
 * ⚠️ 新词首次答错的落点（2026-10-13，R2）：practice/加练阶段 uw 不存在时
 *    也要落一条**只带 wrongCount** 的 user_words 记录 —— 否则 finish_checkin
 *    统一按 wrongCount:0 注册，次日复习的 clean 判定失真（详见下方分支注释）。
 *
 * ⚠️ 复习调度（2026-10-13，R6 用户拍板「仅昨日新词、错词次日不再自动复习」）：
 *    复习是**一轮一次性测验**，出池即终态，不再「次日再复习」：
 *      · clean（一轮一次答对 + 历史无错）→ status='mastered'（毕业）
 *      · 其余（本轮答错过 / 历史有错 / 答错）→ status='reviewed'、nextReviewDate=''
 *    进自动复习池只有一条路：finish_checkin / finish_extra_round 注册
 *    （status='reviewing' + nextReviewDate=次日），所以「昨日新词」= 池内全部。
 *    出池的词答错流水都在 records → 错题本照收；用户在错题本点「已掌握」
 *    （dismiss_wrong 同步置 mastered）才算真正掌握。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const plans = db.collection('daily_plans')
const words = db.collection('words')
const records = db.collection('records')
const userWords = db.collection('user_words')

// 东八区「今天」：先 +8h 再取 UTC 日期；offset 单位＝天
const dateStr = (offset = 0) =>
  new Date(Date.now() + 28800000 + offset * 86400000).toISOString().slice(0, 10)

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const { phase = 'practice', questionIndex, choice, round = 0 } = event
  const r = Number(round) || 0
  const today = dateStr(0)

  try {
    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0]
    if (!plan) return { code: -1, message: '请先初始化当日计划' }

    // 队列路由（C4）：round>0 → 加练组内队列；round===0 → 主流程队列（现有行为不变）
    let queuePath
    let queue
    let groupIdx = -1
    if (r > 0) {
      const groups = Array.isArray(plan.extraRounds) ? plan.extraRounds : []
      groupIdx = groups.findIndex((g) => g.roundId === r)
      if (groupIdx < 0) return { code: -1, message: '加练组不存在' }
      queuePath = `extraRounds.${groupIdx}.practiceQueue`
      queue = Array.isArray(groups[groupIdx].practiceQueue) ? groups[groupIdx].practiceQueue : []
    } else {
      queuePath = phase === 'review' ? 'reviewQueue' : 'practiceQueue'
      queue = Array.isArray(plan[queuePath]) ? plan[queuePath] : []
    }
    const q = queue[questionIndex]
    if (!q) return { code: -1, message: '题目不存在' }

    const correct = Number(choice) === q.answerIndex

    let word = {}
    try {
      word = (await words.doc(q.wordId).get()).data || {}
    } catch (e) {
      word = {}
    }

    await records.add({
      data: {
        _openid: OPENID,
        wordId: q.wordId,
        date: today,
        phase: phase === 'review' ? 'review' : 'practice',
        questionType: q.type,
        isCorrect: correct,
        choice: Number(choice),
        createdAt: new Date()
      }
    })

    const uwRes = await userWords.where({ _openid: OPENID, wordId: q.wordId }).get()
    const uw = uwRes.data[0]

    if (correct) {
      q.passed = true
      if (phase === 'review' && uw) {
        // R6：clean（一轮一次答对 + 历史无错）→ mastered 毕业；
        // 否则出池（'reviewed' + nextReviewDate=''），次日不再自动复习。
        // 出池≠出错题本：答错流水在 records 里，错题本照收（见文件头注释）。
        const clean = !q.wrong && (uw.wrongCount || 0) === 0
        await userWords.doc(uw._id).update({
          data: {
            status: clean ? 'mastered' : 'reviewed',
            round: (uw.round || 1) + 1,
            lastReviewDate: today,
            nextReviewDate: '',
            updatedAt: new Date()
          }
        })
      }
    } else {
      q.wrong = true
      if (uw) {
        // R6：答错即出池（任何阶段），不再写「次日报到」。
        // 当天同一题仍要重选到对才能过（前端禁选 + passed 由答对时置位），
        // 所以先出池不影响当天流程；明天它也不再进复习集合。
        await userWords.doc(uw._id).update({
          data: {
            wrongCount: (uw.wrongCount || 0) + 1,
            status: 'reviewed',
            nextReviewDate: '',
            updatedAt: new Date()
          }
        })
      } else if (phase !== 'review') {
        // 新词首次做题（打卡前 user_words 还没有记录，finish_checkin 才建）——
        // 若不落这条，finish_checkin 会统一按 wrongCount:0 注册，次日复习的
        // 「历史无错」判定（clean）就看不见今天练习答的错，一轮答对即 mastered。
        // ⚠️ 只写 wrongCount，**不写 status / nextReviewDate**：$lte 不匹配
        //    字段缺失，没打卡的词不会因此提前进次日复习集合（仍是「重学」路径）；
        //    finish_checkin 的幂等分支会补调度字段且不覆盖 wrongCount。
        // review 阶段 uw 不存在是数据异常（reviewWordIds 本就来自 user_words），不建。
        await userWords.add({
          data: {
            _openid: OPENID,
            wordId: q.wordId,
            wrongCount: 1,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        })
      }
    }

    const allPassed = queue.every((x) => x.passed)
    if (r > 0) {
      // 加练（C3）：只更新组内队列与组 stage，绝不写 plan.stage。
      // 现状是无条件写 plan.stage，加练一旦复用这段逻辑就会把主流程状态机顶掉。
      await plans.doc(plan._id).update({
        data: {
          [queuePath]: queue,
          [`extraRounds.${groupIdx}.stage`]: allPassed ? 'practice_done' : 'learning',
          updatedAt: new Date()
        }
      })
    } else {
      const patch = { [queuePath]: queue, updatedAt: new Date() }
      if (allPassed && phase === 'review') patch.stage = 'learning'
      if (allPassed && phase === 'practice') patch.stage = 'practice_done'
      await plans.doc(plan._id).update({ data: patch })
    }

    return {
      code: 0,
      data: {
        correct,
        answerIndex: q.answerIndex,
        wordId: q.wordId,
        word: word.word || '',
        meaning: word.meaning || '',
        phaseDone: allPassed
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'SUBMIT_ANSWER_FAILED' }
  }
}
