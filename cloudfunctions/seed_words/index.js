/**
 * seed_words —— 词库导入（管理用，一次性执行）
 *
 * ⚠️ 安全：云函数是「对全体用户开放的接口」，任何小程序用户都能调它。
 *    本函数会在服务端写入 words 集合，故必须携带管理密钥，否则视为未授权。
 *
 * 用法：
 *   0. 【必做】云开发控制台 → 云函数 seed_words → 配置 → 环境变量，
 *      新增 ADMIN_TOKEN = 一个 32 位以上随机串（例：openssl rand -hex 24）
 *   1. 微信开发者工具 → 云开发 → 云函数 seed_words → 「云端测试」
 *   2. 入参（必须带 _token，值与环境变量 ADMIN_TOKEN 完全一致）：
 *        { "_token": "你的密钥" }                        → 导入内置示例词表 words.json
 *        { "_token": "你的密钥", "words": [ ... ] }       → 导入自定义词表
 *   3. 重复执行会自动跳过已存在的单词（按 word 去重）
 *
 * 大批量词表（几千词）请分批导入，避免单次调用超时：
 *   { "_token": "...", "words": [...], "offset": 0,   "limit": 200 }
 *   { "_token": "...", "words": [...], "offset": 200, "limit": 200 }
 *   ... 直到返回 hasMore = false
 *   seq 会自动接着库中最大值往后排，无需手动传 startSeq。
 */
const cloud = require('wx-server-sdk')
const sample = require('./words.json')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const words = db.collection('words')

// 管理密钥：必须配置，未配置时本函数拒绝一切调用（安全默认）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

exports.main = async (event = {}) => {
  // ⚠️ 鉴权：先判空再比较，避免「密钥未配置 + 调用方也不传」被误判为通过
  if (!ADMIN_TOKEN) {
    return { code: -1, message: 'ADMIN_TOKEN_NOT_CONFIGURED：请先在云函数环境变量中配置 ADMIN_TOKEN' }
  }
  if (event._token !== ADMIN_TOKEN) {
    return { code: -1, message: 'INVALID_ADMIN_TOKEN：未授权调用（管理函数只允许持有密钥的调用方使用）' }
  }

  const list = Array.isArray(event.words) && event.words.length ? event.words : sample
  const offset = Math.max(0, Number(event.offset) || 0)
  const limit = Math.max(0, Number(event.limit) || 0)
  const batch = limit > 0 ? list.slice(offset, offset + limit) : list.slice(offset)

  let inserted = 0
  let skipped = 0

  try {
    // seq 起点：显式传入优先；否则从库中现有最大 seq 续号，保证分批导入连续
    let seq = Number(event.startSeq) || 0
    if (!seq) {
      const maxDoc = await words.orderBy('seq', 'desc').limit(1).get()
      seq = (maxDoc.data[0] && Number(maxDoc.data[0].seq)) || 0
    }

    for (const item of batch) {
      if (!item || !item.word) continue
      const exist = await words.where({ word: item.word }).get()
      if (exist.data.length) {
        skipped++
        continue
      }
      seq++
      await words.add({
        data: {
          word: item.word,
          phoneticUK: item.phoneticUK || item.phonetic || '',
          phoneticUS: item.phoneticUS || item.phonetic || '',
          pos: item.pos || '',
          meaning: item.meaning || '',
          seq,
          level: item.level || 1,
          source: item.source || 'seed',
          // 发音音频是否就绪：默认 false，由 seed_audio 上传音频后置 true。
          // start_new_words 只取 audioReady=true 的词，故新导入的词在被
          // 「点亮」前不会进入学习流程。
          audioReady: item.audioReady === true,
          roots: [],
          etymology: '',
          enriched: false,
          enrichStatus: 'pending',
          enrichLockAt: null,
          createdAt: new Date()
        }
      })
      inserted++
    }

    const nextOffset = offset + batch.length
    return {
      code: 0,
      data: {
        inserted,
        skipped,
        total: list.length,
        offset,
        limit,
        nextOffset,
        hasMore: nextOffset < list.length,
        lastSeq: seq
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'SEED_FAILED', data: { inserted, skipped } }
  }
}
