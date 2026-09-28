/**
 * finish_checkin —— 完成打卡（幂等）
 *
 * 前置：当日 practiceQueue 全部答对
 * 动作：写 checkins、更新 streak / totalLearned / wordCursor、
 *       把当日新词注册进复习池（nextReviewDate = 次日）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const users = db.collection('users')
const plans = db.collection('daily_plans')
const checkins = db.collection('checkins')
const userWords = db.collection('user_words')
const words = db.collection('words')

function dateStr(offset = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const today = dateStr(0)

  try {
    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0]
    if (!plan) return { code: -1, message: '请先初始化当日计划' }

    const queue = Array.isArray(plan.practiceQueue) ? plan.practiceQueue : []
    if (!queue.length) return { code: -1, message: '尚未完成练习' }
    if (!queue.every((q) => q.passed)) return { code: -1, message: '仍有未答对的题目' }

    const userRes = await users.where({ _openid: OPENID }).get()
    const user = userRes.data[0]
    if (!user) return { code: -1, message: '用户不存在' }

    const existing = await checkins.where({ _openid: OPENID, date: today }).get()
    if (existing.data.length) {
      return {
        code: 0,
        data: { already: true, streak: user.streak || 0, totalLearned: user.totalLearned || 0 }
      }
    }

    const yesterday = dateStr(-1)
    const streak = user.lastCheckinDate === yesterday ? (user.streak || 0) + 1 : 1
    const newWordIds = plan.newWordIds || []
    const learnedCount = newWordIds.length

    // 游标按 seq 推进，而不是按「当日词数」累加。
    // 出词条件带 audioReady 过滤后，可出的词可能不连续（音频是分批生成的）；
    // 若继续用「游标 + 词数」，遇到缺口就会错位并重复出词。
    let nextCursor = user.wordCursor || 0
    if (newWordIds.length) {
      const last = await words
        .where({ _id: _.in(newWordIds) })
        .orderBy('seq', 'desc')
        .limit(1)
        .get()
      const maxSeq = Number(last.data[0] && last.data[0].seq) || 0
      if (maxSeq > nextCursor) nextCursor = maxSeq
    }

    await checkins.add({
      data: {
        _openid: OPENID,
        date: today,
        streakAtCheckin: streak,
        learnedCount,
        createdAt: new Date()
      }
    })

    await users.doc(user._id).update({
      data: {
        streak,
        lastCheckinDate: today,
        totalLearned: (user.totalLearned || 0) + learnedCount,
        wordCursor: nextCursor,
        updatedAt: new Date()
      }
    })

    // 新词进入复习池（幂等）
    for (const wid of newWordIds) {
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

    await plans.doc(plan._id).update({ data: { stage: 'done', updatedAt: new Date() } })

    return {
      code: 0,
      data: {
        already: false,
        streak,
        learnedCount,
        totalLearned: (user.totalLearned || 0) + learnedCount
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'FINISH_CHECKIN_FAILED' }
  }
}
