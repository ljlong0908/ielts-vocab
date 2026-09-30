/**
 * home_summary —— 首页聚合数据
 *
 * 只返回首页真正消费的字段（连续打卡 / 累计学习 / 今日进度 / 今日是否完成）。
 * 打卡总天数由 stats 云函数提供（统计页），此处不做重复统计，省一次 DB 往返。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const users = db.collection('users')
const plans = db.collection('daily_plans')
const checkins = db.collection('checkins')

function dateStr(offset = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const today = dateStr(0)

  try {
    const userRes = await users.where({ _openid: OPENID }).get()
    const user = userRes.data[0] || { dailyGoal: 5, streak: 0, totalLearned: 0 }

    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0] || null

    const ckRes = await checkins.where({ _openid: OPENID, date: today }).get()
    const todayDone = ckRes.data.length > 0

    // 加练：当日已学到（走过学习页）的加练词数，供首页进度卡展示。
    // ⚠️ 与 totalLearned 的口径不同，别混用：totalLearned 只在**结算**
    //    （finish_extra_round）时按整组入账；这里的 learnedIds 含「学了但还没做完小测」的在途组，
    //    所以 extraLearnedToday ≥ 今日已入账的加练词数，是正常的。
    const rounds = plan && Array.isArray(plan.extraRounds) ? plan.extraRounds : []
    const extraLearnedToday = rounds.reduce((s, r) => s + ((r.learnedIds || []).length), 0)

    return {
      code: 0,
      data: {
        dailyGoal: user.dailyGoal || 5,
        streak: user.streak || 0,
        totalLearned: user.totalLearned || 0,
        learnedToday: plan ? (plan.learnedIds || []).length : 0,
        extraLearnedToday,
        todayDone
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'HOME_SUMMARY_FAILED' }
  }
}
