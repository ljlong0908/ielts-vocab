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
 * 返回：{ code: 0, data: { wordId, updated } }
 *   updated = 被标记的记录条数（同一个词可能答错多次，会有多条）
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const records = db.collection('records')

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

    return { code: 0, data: { wordId, updated: (r.stats && r.stats.updated) || 0 } }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'DISMISS_FAILED' }
  }
}
