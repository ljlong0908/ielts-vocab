/**
 * start_new_words —— 幂等生成当日新词队列
 *
 * 出词策略：按 words.seq 递增取词（每本书顺序学习），
 *          游标 user.wordCursor 在「完成打卡」时才推进。
 *
 * ⚠️ 只出「已有发音音频」的词：条件带 audioReady: true。
 *    音频是本地离线预生成后由 seed_audio 上传并点亮的，没音频的词
 *    audioReady 为 false（或字段缺失），不会进入学习流程，避免出现
 *    「点发音没声音」的体验断裂。
 *    因此 wordCursor 必须按 seq 取值推进（见 finish_checkin），
 *    否则词不连续时游标会错位、导致重复出词。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const users = db.collection('users')
const plans = db.collection('daily_plans')
const words = db.collection('words')

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

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const today = dateStr(0)

  try {
    const user = await getUser(OPENID)
    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0]
    if (!plan) return { code: -1, message: '请先初始化当日计划' }

    if (plan.newWordIds && plan.newWordIds.length > 0) {
      return { code: 0, data: { newWordIds: plan.newWordIds, reused: true } }
    }

    const goal = user.dailyGoal || 5
    const picked = await words
      .where({ seq: _.gt(user.wordCursor || 0), audioReady: true })
      .orderBy('seq', 'asc')
      .limit(goal)
      .get()

    const newWordIds = picked.data.map((w) => w._id)

    await plans.doc(plan._id).update({
      data: {
        newWordIds,
        stage: newWordIds.length ? 'learning' : 'done',
        updatedAt: new Date()
      }
    })

    return {
      code: 0,
      data: {
        newWordIds,
        reused: false,
        exhausted: newWordIds.length === 0
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'START_NEW_WORDS_FAILED' }
  }
}
