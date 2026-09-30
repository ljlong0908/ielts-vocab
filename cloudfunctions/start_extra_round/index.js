/**
 * start_extra_round —— 发起「再学一组」（加练）
 *
 * 设计要点（详见 docs/project-spec.md §11.5 的四个技术冲突）：
 *   C1 一天只有一条 plan（唯一索引 _openid+date）→ 加练组内嵌为 plan.extraRounds[]，不另建文档
 *   C2 加练词绝不写入 plan.newWordIds（打卡时按 newWordIds 推进游标与计数）
 *   ⛔ 不推进 wordCursor —— 游标只在该组「学完」时推进（见 finish_extra_round），
 *      中途退出这些词次日会被 start_new_words 重新取到，这是正确行为
 *
 * 决策：D1=A（仅当日已打卡后可加练）；D2=沿用 user.dailyGoal 作每组词数
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const users = db.collection('users')
const plans = db.collection('daily_plans')
const words = db.collection('words')
const checkins = db.collection('checkins')

// ⚠️ 每日加练上限已取消（2026-09-29 用户拍板「不限次数」）。
//    唯一的自然终点是词库取尽（下面的 exhausted 分支）。
//    若将来要恢复上限：把常量改回数字，并在创建组之前加回 `rounds.length >= MAX` 判断。
const MAX_ROUNDS_PER_DAY = Infinity

// 东八区「今天」：先 +8h 再取 UTC 日期；offset 单位＝天
const dateStr = (offset = 0) =>
  new Date(Date.now() + 28800000 + offset * 86400000).toISOString().slice(0, 10)

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const today = dateStr(0)

  try {
    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0]
    if (!plan) return { code: -1, message: '请先初始化当日计划' }

    // D1=A 前置：今日已打卡才可加练
    const ck = await checkins.where({ _openid: OPENID, date: today }).get()
    if (!ck.data.length) return { code: -1, message: '完成今日打卡后可加练' }

    const userRes = await users.where({ _openid: OPENID }).get()
    const user = userRes.data[0]
    if (!user) return { code: -1, message: '用户不存在' }

    const goal = user.dailyGoal || 5
    const rounds = Array.isArray(plan.extraRounds) ? plan.extraRounds : []

    // 幂等：末尾存在未完成的组 → 直接复用，不新建（连点两次只创建一组）
    const pending = rounds.filter((r) => r.stage !== 'done')
    if (pending.length) {
      const g = pending[pending.length - 1]
      return {
        code: 0,
        data: { roundId: g.roundId, wordIds: g.wordIds || [], reused: true, exhausted: false }
      }
    }

    // 上限（当前 MAX 为 Infinity → 该分支不生效；留着作为「恢复上限」的唯一改动点）
    if (rounds.length >= MAX_ROUNDS_PER_DAY) {
      return { code: -1, message: '今日加练已达上限' }
    }

    // 取词：seq > 游标 且 音频就绪；排除当日主流程与已出过的加练词
    const used = new Set(plan.newWordIds || [])
    rounds.forEach((r) => (r.wordIds || []).forEach((id) => used.add(id)))

    const where = { seq: _.gt(user.wordCursor || 0), audioReady: true }
    if (used.size) where._id = _.nin(Array.from(used))

    const picked = await words.where(where).orderBy('seq', 'asc').limit(goal).get()
    const wordIds = picked.data.map((w) => w._id)

    // 词库取尽：返回 exhausted，不创建空组
    if (!wordIds.length) {
      return { code: 0, data: { roundId: null, wordIds: [], reused: false, exhausted: true } }
    }

    const roundId = rounds.reduce((mx, r) => Math.max(mx, r.roundId || 0), 0) + 1
    const group = {
      roundId,
      wordIds,
      learnedIds: [],
      practiceQueue: [],
      stage: 'learning',
      startedAt: new Date(),
      finishedAt: null
    }

    // 直接用「读到的数组 + 新组」回写整个字段，不用 _.push —— SDK 里 push 是变参签名，
    // push([g]) 有把整个数组当成单个元素的风险；上面的幂等判定已挡住并发重复创建，
    // 极端并发最多丢一组（文档明确接受，不引入分布式锁）。
    await plans.doc(plan._id).update({
      data: { extraRounds: rounds.concat([group]), updatedAt: new Date() }
    })

    return { code: 0, data: { roundId, wordIds, reused: false, exhausted: false } }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'START_EXTRA_ROUND_FAILED' }
  }
}
