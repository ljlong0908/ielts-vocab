/**
 * finish_extra_round —— 完成一组加练
 *
 * 前置：该组 practiceQueue 全部答对（与 finish_checkin 同规则）
 *
 * ⛔ 不动主流程四样资产：plan.stage / plan.newWordIds / checkins / users.streak
 * ✅ 计入「累计学习」：users.totalLearned += 本组词数
 *      （D3 原定「不计入」，2026-09-29 用户要求改为计入；口径与 finish_checkin 对称 ——
 *        都是「结算时按本组词数一次性入账」，用 wordIds.length 而非 learnedIds.length，
 *        与 finish_checkin 用 plan.newWordIds.length 一致，避免「学完但没走完 next()」少计）
 * ✅ 推进 wordCursor 到本组 max(seq)（否则次日 start_new_words 会重复出这些词）
 * ✅ 加练词注册进 user_words 复习池（nextReviewDate = 次日）——学过的东西仍要复习
 *
 * 幂等：组 stage==='done' 直接返回，**不重复累加 totalLearned**（本函数唯一的计数风险点）。
 * 中途退出（学了一半没做练习）不会入账；这些词因 wordCursor 未推进，
 * 次日会被 start_new_words 当新词重新取到，届时由 finish_checkin 计入 —— 不会漏计，只是延后。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const users = db.collection('users')
const plans = db.collection('daily_plans')
const words = db.collection('words')
const userWords = db.collection('user_words')

// 东八区「今天」：先 +8h 再取 UTC 日期；offset 单位＝天
const dateStr = (offset = 0) =>
  new Date(Date.now() + 28800000 + offset * 86400000).toISOString().slice(0, 10)

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const { roundId } = event
  const today = dateStr(0)

  try {
    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0]
    if (!plan) return { code: -1, message: '请先初始化当日计划' }

    const rounds = Array.isArray(plan.extraRounds) ? plan.extraRounds : []
    const idx = rounds.findIndex((r) => r.roundId === Number(roundId))
    if (idx < 0) return { code: -1, message: '加练组不存在' }

    const group = rounds[idx]
    const wordIds = group.wordIds || []

    const userRes = await users.where({ _openid: OPENID }).get()
    const user = userRes.data[0]
    if (!user) return { code: -1, message: '用户不存在' }

    // 幂等：该组已完成过 —— 本组词数在首次结算时已计入 totalLearned，
    // 这里只回读当前值，**绝不重复累加**（重复调用是前端重试/连点兜底的正常路径）
    if (group.stage === 'done') {
      return {
        code: 0,
        data: {
          already: true,
          roundId: group.roundId,
          learnedCount: wordIds.length,
          totalLearned: user.totalLearned || 0
        }
      }
    }

    const queue = Array.isArray(group.practiceQueue) ? group.practiceQueue : []
    if (!queue.length) return { code: -1, message: '尚未完成加练练习' }
    if (!queue.every((q) => q.passed)) return { code: -1, message: '仍有未答对的题目' }

    // 游标按 seq 推进，不能按词数累加（同 finish_checkin:58-67；
    // 音频分批生成导致可出的词不连续，累加会错位并重复出词）
    let nextCursor = user.wordCursor || 0
    if (wordIds.length) {
      const last = await words
        .where({ _id: _.in(wordIds) })
        .orderBy('seq', 'desc')
        .limit(1)
        .get()
      const maxSeq = Number(last.data[0] && last.data[0].seq) || 0
      if (maxSeq > nextCursor) nextCursor = maxSeq
    }

    // 结算入账：推进游标 + 计入累计学习（幂等已由上面的 stage==='done' 兜住）
    const learnedCount = wordIds.length
    const nextTotal = (user.totalLearned || 0) + learnedCount
    await users.doc(user._id).update({
      data: { wordCursor: nextCursor, totalLearned: nextTotal, updatedAt: new Date() }
    })

    // 加练词进复习池（幂等 upsert，逻辑与 finish_checkin:90-111 一致）
    for (const wid of wordIds) {
      const ex = await userWords.where({ _openid: OPENID, wordId: wid }).get()
      if (ex.data.length) {
        await userWords.doc(ex.data[0]._id).update({
          data: { status: 'reviewing', nextReviewDate: dateStr(1), updatedAt: new Date() }
        })
      } else {
        await userWords.add({
          data: {
            _openid: OPENID,
            wordId: wid,
            status: 'reviewing',
            round: 1,
            wrongCount: 0,
            firstLearnedDate: today,
            nextReviewDate: dateStr(1),
            createdAt: new Date(),
            updatedAt: new Date()
          }
        })
      }
    }

    await plans.doc(plan._id).update({
      data: {
        [`extraRounds.${idx}.stage`]: 'done',
        [`extraRounds.${idx}.finishedAt`]: new Date(),
        updatedAt: new Date()
      }
    })

    return {
      code: 0,
      data: {
        already: false,
        roundId: group.roundId,
        learnedCount,
        totalLearned: nextTotal
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'FINISH_EXTRA_ROUND_FAILED' }
  }
}
