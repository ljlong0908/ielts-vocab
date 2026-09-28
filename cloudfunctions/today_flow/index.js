/**
 * today_flow —— 当日流程状态编排（前端唯一状态来源）
 *
 * 返回：{ plan, dailyGoal, streak, totalLearned }
 *   plan.stage: review | learning | practice | practice_done | done
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const users = db.collection('users')
const plans = db.collection('daily_plans')
const userWords = db.collection('user_words')
const checkins = db.collection('checkins')

function dateStr(offset = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

async function getUser(openid) {
  const r = await users.where({ _openid: openid }).get()
  if (r.data[0]) return r.data[0]
  const data = {
    _openid: openid,
    // 未接入微信头像/昵称授权（前端不调 getUserProfile），不收集该信息，暂注释：
    // nickname: '',
    // avatarUrl: '',
    dailyGoal: 5,
    streak: 0,
    lastCheckinDate: '',
    totalLearned: 0,
    wordCursor: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  }
  const add = await users.add({ data })
  return Object.assign({ _id: add._id }, data)
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const today = dateStr(0)

  try {
    // 轻量动作：标记某词已学习（供学习页逐步推进进度）
    if (event.action === 'markLearned' && event.wordId) {
      const p = await plans.where({ _openid: OPENID, date: today }).get()
      const cur = p.data[0]
      if (cur) {
        await plans.doc(cur._id).update({
          data: { learnedIds: _.addToSet(event.wordId), updatedAt: new Date() }
        })
      }
      return { code: 0, data: { ok: true } }
    }

    const user = await getUser(OPENID)

    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    let plan = planRes.data[0]

    if (!plan) {
      // 待复习 = 非已掌握 且 复习日 <= 今天
      const pending = await userWords
        .where({ _openid: OPENID, status: _.neq('mastered'), nextReviewDate: _.lte(today) })
        .limit(50)
        .get()
      const reviewWordIds = pending.data.map((x) => x.wordId)

      const data = {
        _openid: OPENID,
        date: today,
        reviewWordIds,
        newWordIds: [],
        learnedIds: [],
        reviewQueue: [],
        practiceQueue: [],
        stage: reviewWordIds.length > 0 ? 'review' : 'learning',
        createdAt: new Date(),
        updatedAt: new Date()
      }
      const add = await plans.add({ data })
      plan = Object.assign({ _id: add._id }, data)
    }

    const ck = await checkins.where({ _openid: OPENID, date: today }).get()
    if (ck.data.length > 0) plan.stage = 'done'

    return {
      code: 0,
      data: {
        plan,
        dailyGoal: user.dailyGoal,
        streak: user.streak,
        totalLearned: user.totalLearned
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'TODAY_FLOW_FAILED' }
  }
}
