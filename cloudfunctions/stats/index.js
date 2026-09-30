/**
 * stats —— 统计页数据（打卡日历 + 累计数据 + 错题）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const users = db.collection('users')
const checkins = db.collection('checkins')
const records = db.collection('records')
const words = db.collection('words')

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  try {
    const userRes = await users.where({ _openid: OPENID }).get()
    const user = userRes.data[0] || { streak: 0, totalLearned: 0, dailyGoal: 5 }

    const checkinRes = await checkins
      .where({ _openid: OPENID })
      .orderBy('date', 'desc')
      .limit(200)
      .get()

    // 错题（去重取最近）；已被用户标「已掌握」的排除在外（dismiss_wrong 打标）。
    // ⚠️ `_.neq(true)` 会一并匹配「字段不存在」的记录（MongoDB $ne 语义），
    //    所以加这个字段**不需要回填历史数据**；之后再答错写的是新记录（无该字段），
    //    自然重新进错题本。
    const wrongRes = await records
      .where({ _openid: OPENID, isCorrect: false, mastered: _.neq(true) })
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get()

    const seen = {}
    const wrongWordIds = []
    for (const r of wrongRes.data) {
      if (!seen[r.wordId]) {
        seen[r.wordId] = true
        wrongWordIds.push(r.wordId)
      }
      if (wrongWordIds.length >= 50) break
    }

    let wrongWords = []
    if (wrongWordIds.length) {
      const w = await words
        .where({ _id: _.in(wrongWordIds) })
        .field({ word: true, meaning: true, phoneticUS: true, phoneticUK: true })
        .get()
      const map = {}
      w.data.forEach((x) => {
        map[x._id] = x
      })
      wrongWords = wrongWordIds.map((id) => map[id]).filter(Boolean)
    }

    return {
      code: 0,
      data: {
        streak: user.streak || 0,
        totalLearned: user.totalLearned || 0,
        dailyGoal: user.dailyGoal || 5,
        totalCheckins: checkinRes.data.length,
        dates: checkinRes.data.map((x) => x.date),
        wrongWords
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'STATS_FAILED' }
  }
}
