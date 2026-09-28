/**
 * user_profile —— 登录（获取/创建用户）与设置每日目标
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const users = db.collection('users')

function defaultUser(openid) {
  return {
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
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const { action = 'get', dailyGoal } = event

  try {
    const res = await users.where({ _openid: OPENID }).get()
    let user = res.data[0]

    if (!user) {
      const data = defaultUser(OPENID)
      const add = await users.add({ data })
      user = Object.assign({ _id: add._id }, data)
    }

    if (action === 'setGoal') {
      const goal = Number(dailyGoal) === 10 ? 10 : 5
      await users.doc(user._id).update({ data: { dailyGoal: goal, updatedAt: new Date() } })
      user.dailyGoal = goal
    }

    return { code: 0, data: user }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'USER_PROFILE_FAILED' }
  }
}
