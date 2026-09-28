/**
 * word_card —— 获取单词卡（含 AI 补全 + 缓存）
 *
 * 流程：
 *   1. 读取 words 文档；若 enriched=true → 直接返回（命中缓存，不调模型）
 *   2. 否则同步调用 enrich_word 补全，再读取一次
 *   3. 若仍未被补全（例如他人正在生成/生成失败）→ 返回已有字段 + enriching 标记
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const words = db.collection('words')

async function readWord(wordId) {
  try {
    const doc = await words.doc(wordId).get()
    return doc.data
  } catch (e) {
    return null
  }
}

exports.main = async (event = {}) => {
  const { wordId } = event
  if (!wordId) return { code: -1, message: 'missing wordId' }

  try {
    let w = await readWord(wordId)
    if (!w) return { code: -1, message: '单词不存在' }

    if (!w.enriched) {
      try {
        await cloud.callFunction({ name: 'enrich_word', data: { wordId } })
      } catch (e) {
        // 忽略：降级返回词表已有字段
        console.warn('[word_card] enrich failed:', (e && e.message) || e)
      }
      const again = await readWord(wordId)
      if (again) w = again
    }

    return { code: 0, data: Object.assign({}, w, { enriching: !w.enriched }) }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'WORD_CARD_FAILED' }
  }
}
