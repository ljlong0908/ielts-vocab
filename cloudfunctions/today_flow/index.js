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
const words = db.collection('words')

// ⚠️ 每日加练上限已取消（2026-09-29 用户拍板「不限次数」）。
//    这里保留 limitReached 字段是为了前端契约稳定（`index.js:buildExtra` 会读它），
//    值恒为 false。真正的自然终点是 exhausted（audioReady 词池取尽）。
//    若将来要恢复上限：改回 `rounds.length >= N` 即可，前端无需改动。
const MAX_ROUNDS_PER_DAY = Infinity

// 东八区「今天」：先 +8h 再取 UTC 日期；offset 单位＝天
const dateStr = (offset = 0) =>
  new Date(Date.now() + 28800000 + offset * 86400000).toISOString().slice(0, 10)

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
    // round>0（加练）时写该组的 learnedIds —— 绝不写主流程 learnedIds，
    // 否则加练会让首页「今日进度」虚涨（与 C2 同源的坑）。
    if (event.action === 'markLearned' && event.wordId) {
      const r = Number(event.round) || 0
      const p = await plans.where({ _openid: OPENID, date: today }).get()
      const cur = p.data[0]
      if (cur) {
        if (r > 0) {
          const groups = Array.isArray(cur.extraRounds) ? cur.extraRounds : []
          const gi = groups.findIndex((g) => g.roundId === r)
          if (gi >= 0) {
            await plans.doc(cur._id).update({
              data: {
                [`extraRounds.${gi}.learnedIds`]: _.addToSet(event.wordId),
                updatedAt: new Date()
              }
            })
          }
        } else {
          await plans.doc(cur._id).update({
            data: { learnedIds: _.addToSet(event.wordId), updatedAt: new Date() }
          })
        }
      }
      return { code: 0, data: { ok: true } }
    }

    const user = await getUser(OPENID)

    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    let plan = planRes.data[0]

    if (!plan) {
      // 待复习 = 在复习池中（status='reviewing'）且 复习日 <= 今天。
      // ⚠️ R6（2026-10-13）：正相匹配 'reviewing'，**不能**用 _.neq('mastered') ——
      //    复习出池的终态 'reviewed'（答错/非一轮干净答对，见 submit_answer）也是
      //    「非 mastered」，用 neq 会把它们捞回池里，「错词次日不再自动复习」被悄悄破坏。
      //    进池只有 finish_checkin / finish_extra_round 一条路，所以池内 = 昨日新词。
      // ⚠️ 仍用 lte(today) 而不是 ==today：断档N天回来时，之前注册没复习的词
      //    要能补上（配合下面的 orderBy，最老的先复习）。
      // ⚠️ orderBy 不能省：超量积压时（断档多日）无排序截断会让数据库自然序里
      //    靠后的词永远排不进前 50 条 —— 天天取同一批，队尾饿死。
      //    按 nextReviewDate 升序保证「最老先复习」，新注册的词排在其后。
      const pending = await userWords
        .where({ _openid: OPENID, status: 'reviewing', nextReviewDate: _.lte(today) })
        .orderBy('nextReviewDate', 'asc')
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
    const checkedToday = ck.data.length > 0
    // ⚠️ 现状：已打卡时把 plan.stage 强制改写为 'done'，且只改内存不落库。
    //    加练不依赖 stage，此处保持原样，别顺手改成写库（会破坏状态机可追溯性）。
    if (checkedToday) plan.stage = 'done'

    // ===== 加练聚合（D1=A：仅当日已打卡后可用）=====
    const rounds = Array.isArray(plan.extraRounds) ? plan.extraRounds : []
    const limitReached = rounds.length >= MAX_ROUNDS_PER_DAY
    const pending = rounds.filter((r) => r.stage !== 'done')
    const extraLearnedToday = rounds.reduce((s, r) => s + ((r.learnedIds || []).length), 0)
    const groupSize = user.dailyGoal || 5

    let exhausted = false
    // 只在「已打卡 且 无未完成组 且 未达上限」时才去查词库余量，省掉平时的往返
    if (checkedToday && !pending.length && !limitReached) {
      const used = new Set(plan.newWordIds || [])
      rounds.forEach((r) => (r.wordIds || []).forEach((id) => used.add(id)))
      const w = { seq: _.gt(user.wordCursor || 0), audioReady: true }
      if (used.size) w._id = _.nin(Array.from(used))
      const rest = await words.where(w).limit(1).get()
      exhausted = rest.data.length === 0
    }

    const canStart = checkedToday && (pending.length > 0 || (!limitReached && !exhausted))

    // 剥掉加练组里的 practiceQueue（含 answerIndex）再下发，避免答案随 plan 泄露
    const safeRounds = rounds.map((r) => {
      const o = Object.assign({}, r)
      delete o.practiceQueue
      return o
    })

    return {
      code: 0,
      data: {
        plan: Object.assign({}, plan, { extraRounds: safeRounds }),
        dailyGoal: user.dailyGoal,
        streak: user.streak,
        totalLearned: user.totalLearned,
        extra: {
          canStart,
          exhausted,
          limitReached,
          pendingRound: pending.length ? { roundId: pending[pending.length - 1].roundId } : null,
          roundsToday: rounds.length - pending.length,
          extraLearnedToday,
          groupSize
        }
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'TODAY_FLOW_FAILED' }
  }
}
