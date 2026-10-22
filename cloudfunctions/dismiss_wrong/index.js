/**
 * dismiss_wrong —— 把某个错题标记为「已掌握」，从错题本移除
 *
 * 语义：用户自评「这个词我已经会了」。
 * ⚠️ 设计取舍：**不删流水**，只在 records 的该词错题记录上打 `mastered: true`，
 *    错题本查询（stats）据此过滤。三个好处：
 *      ① 答题流水保持完整，将来按 records 统计正确率仍然准确
 *      ② 「复活」零成本：以后再答错会写**新记录**（不带 mastered 字段），
 *         自然重新进错题本，不需要任何反向清理逻辑
 *      ③ 不做物理删除 → 误点也能人工恢复（mastered 置 false 即可）
 *
 * 入参：{ wordId }
 * 返回：{ code: 0, data: { wordId, updated, scheduleSynced } }
 *   updated = 被标记的记录条数（同一个词可能答错多次，会有多条）
 *   scheduleSynced = 是否同步了复习调度（user_words 置 mastered）
 *
 * ⚠️ 复习调度同步（2026-10-13，R1）：只打 records 标不够 —— 次日复习集合查的是
 *    `user_words`（status='reviewing' 且 nextReviewDate≤今天，见 today_flow），
 *    两套系统不通时，用户在错题本点了「已掌握」，次日复习照考这个词。
 *    所以这里同时把 user_words 该词置 mastered（nextReviewDate 清空）。
 *    ⚠️ R6 之后这里是「出池词（'reviewed'）转正」的唯一入口：复习答错的词次日
 *    不再自动复习，用户只有在这里点「已掌握」才会把它变成 mastered。
 *    user_words 没有该词记录时**不建**：那说明它学了但没打卡，次日会重学，
 *    重学后一轮答对即 mastered，可自愈；硬建一条反而会让没学完的词提前进复习。
 *    同步只影响「明天起」—— 当日 reviewQueue 是建 plan 时的快照，今天仍会考它。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const records = db.collection('records')
const userWords = db.collection('user_words')

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const wordId = event && event.wordId
  if (!wordId) return { code: 1, message: 'MISSING_WORD_ID' }

  try {
    // 幂等：重复标记只是重写同一个值（updated 会把已标记的再算一遍），无副作用。
    // 不写 `mastered: _.neq(true)` 条件 —— where().update() 的 command 支持面
    // 不如查询广，少一个不确定项更稳；重复调用无副作用，就不必省这一次写。
    const r = await records
      .where({ _openid: OPENID, wordId, isCorrect: false })
      .update({ data: { mastered: true, masteredAt: new Date() } })

    // 复习调度同步：错题本说「会了」，次日复习集合就不要再包含它。
    // 记录不存在则跳过（见头注释的说明），不作为失败。
    const uwRes = await userWords.where({ _openid: OPENID, wordId }).get()
    let scheduleSynced = false
    if (uwRes.data.length) {
      await userWords.doc(uwRes.data[0]._id).update({
        data: { status: 'mastered', nextReviewDate: '', updatedAt: new Date() }
      })
      scheduleSynced = true
    }

    return {
      code: 0,
      data: {
        wordId,
        updated: (r.stats && r.stats.updated) || 0,
        scheduleSynced
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'DISMISS_FAILED' }
  }
}
