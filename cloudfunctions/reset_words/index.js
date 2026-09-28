/**
 * reset_words —— 词库重置（管理用，⚠️ 破坏性操作，不可撤销）
 *
 * 用途：把 words 及所有「按 words._id 引用」的派生数据一并清空，用于
 *       「推倒重来、换一套词表重新导入」。
 *
 * ⚠️ 为什么不能只删 words 了事：
 *   下面这些集合都存了 words 的 _id（wordId），删词后它们会变成孤儿数据——
 *   错题本查不到词、复习池推不动、当日计划打不开。
 *
 *     user_words    .wordId
 *     records       .wordId
 *     daily_plans   .newWordIds[] / .reviewWordIds[] / .practiceQueue[].wordId
 *     users         .wordCursor（按 seq 推进的出词游标，必须归零）
 *
 *   而下面这些**不**依赖 _id，默认保留：
 *     checkins      只有日期/次数，不含词引用
 *     audio_cache   按 text 建索引，重导同名词后可直接复用
 *
 * ⚠️ 安全：云函数对全体用户开放，入参可伪造。本函数会删数据，故：
 *   1. 必须携带 _token（环境变量 ADMIN_TOKEN）
 *   2. 真正执行必须额外传 confirm: "PURGE"（双保险，避免误触）
 *
 * 用法（云开发控制台 → 云函数 reset_words → 云端测试）：
 *
 *   ① 先预检（只读，不改任何数据）：
 *      { "_token": "你的密钥", "mode": "preview" }
 *      返回各集合条数与「有学习进度的用户数」，据此判断影响面。
 *
 *   ② 确认无误后执行：
 *      { "_token": "你的密钥", "mode": "purge", "confirm": "PURGE" }
 *
 *   可选参数：
 *      "collections": ["words","user_words","records","daily_plans"]
 *                     自定义清理范围（白名单内），默认即这四个
 *      "resetCursor": false    不重置 users.wordCursor（默认重置）
 *      "resetStats": true      连同 streak / totalLearned / lastCheckinDate 一并归零，
 *                              并清空 checkins（默认 false，即保留打卡历史）
 *
 * 执行完的后续动作：
 *   1. seed_words  导入新词表（清空后 seq 会从 1 开始，与词表顺序一致）
 *   2. seed_audio  重新点亮 audioReady
 *
 * ⚠️ 执行前务必在控制台「数据库 → 集合 → 导出」备份一份，本操作不可撤销。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 管理密钥：必须配置，未配置时本函数拒绝一切调用（安全默认）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

// 允许清理的集合白名单
const ALLOWED = ['words', 'user_words', 'records', 'daily_plans', 'checkins', 'audio_cache']

// 默认清理范围：words 本体 + 三个持有 wordId 的派生集合
const DEFAULT_TARGETS = ['words', 'user_words', 'records', 'daily_plans']

const CONFIRM_WORD = 'PURGE'   // 执行口令
const BATCH = 100              // 每轮删除条数（云函数端 where().remove() 单次上限 1000）
const MAX_ROUNDS = 2000        // 轮数上限，防死循环

/** 统计单个集合条数；集合不存在时返回 -1 而不是抛错 */
async function safeCount(name) {
  try {
    const r = await db.collection(name).count()
    return r.total
  } catch (e) {
    return -1
  }
}

/** 全量快照：各集合条数 + 有多少用户已有学习进度 */
async function snapshot() {
  const collections = {}
  for (const name of ALLOWED) {
    collections[name] = await safeCount(name)
  }

  let usersWithProgress = -1
  try {
    const r = await db.collection('users').where({ wordCursor: _.gt(0) }).count()
    usersWithProgress = r.total
  } catch (e) { /* 集合不存在则忽略 */ }

  return { collections, usersWithProgress }
}

/** 分批清空一个集合，返回实际删除条数 */
async function purge(name) {
  const col = db.collection(name)
  let removed = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const page = await col
      .where({ _id: _.exists(true) })
      .field({ _id: true })
      .limit(BATCH)
      .get()

    if (!page.data.length) break

    const ids = page.data.map((d) => d._id)
    const res = await col.where({ _id: _.in(ids) }).remove()
    const n = (res && res.stats && res.stats.removed) || 0
    removed += n

    if (n === 0) break                    // 删不动了，避免死循环
    if (page.data.length < BATCH) break   // 最后一批
  }

  return removed
}

exports.main = async (event = {}) => {
  // ⚠️ 鉴权：先判空再比较，避免「密钥未配置 + 调用方也不传」被误判为通过
  if (!ADMIN_TOKEN) {
    return { code: -1, message: 'ADMIN_TOKEN_NOT_CONFIGURED：请先在云函数环境变量中配置 ADMIN_TOKEN' }
  }
  if (event._token !== ADMIN_TOKEN) {
    return { code: -1, message: 'INVALID_ADMIN_TOKEN：未授权调用（管理函数只允许持有密钥的调用方使用）' }
  }

  const mode = String(event.mode || 'preview').toLowerCase()

  // ---------- 预检（只读）----------
  if (mode === 'preview') {
    const before = await snapshot()
    return {
      code: 0,
      data: {
        mode: 'preview',
        before,
        wouldPurge: DEFAULT_TARGETS,
        keptByDefault: ['checkins', 'audio_cache'],
        hint: '确认影响面后，改传 { mode: "purge", confirm: "PURGE" } 执行清理'
      }
    }
  }

  if (mode !== 'purge') {
    return { code: -1, message: `INVALID_MODE：只支持 preview / purge，收到「${mode}」` }
  }

  // ---------- 二次确认 ----------
  if (String(event.confirm || '') !== CONFIRM_WORD) {
    return {
      code: -1,
      message: `NEED_CONFIRM：破坏性操作不可撤销，需显式传 confirm: "${CONFIRM_WORD}"`
    }
  }

  const requested = Array.isArray(event.collections) && event.collections.length
    ? event.collections.map((s) => String(s).toLowerCase())
    : DEFAULT_TARGETS

  const targets = requested.filter((n) => ALLOWED.includes(n))
  const rejected = requested.filter((n) => !ALLOWED.includes(n))
  if (!targets.length) return { code: -1, message: 'NO_VALID_TARGET：collections 中没有白名单内的集合' }

  const before = await snapshot()
  const removed = {}
  const errors = []

  // ---------- 清空集合 ----------
  for (const name of targets) {
    try {
      removed[name] = await purge(name)
    } catch (e) {
      removed[name] = 0
      errors.push({ collection: name, error: (e && e.message) || 'PURGE_FAILED' })
    }
  }

  // ---------- 重置出词游标 ----------
  // 清空 words 后新词从 seq 1 重新开始，游标不归零会导致前 N 个词被永久跳过
  let cursorReset = 0
  if (event.resetCursor !== false) {
    try {
      const r = await db.collection('users')
        .where({ wordCursor: _.gt(0) })
        .update({ data: { wordCursor: 0, updatedAt: new Date() } })
      cursorReset = (r && r.stats && r.stats.updated) || 0
    } catch (e) {
      errors.push({ collection: 'users.wordCursor', error: (e && e.message) || 'RESET_FAILED' })
    }
  }

  // ---------- 可选：进度统计一并归零 ----------
  let statsReset = 0
  if (event.resetStats === true) {
    try {
      const r = await db.collection('users').where({ _id: _.exists(true) }).update({
        data: { streak: 0, totalLearned: 0, lastCheckinDate: '', updatedAt: new Date() }
      })
      statsReset = (r && r.stats && r.stats.updated) || 0
    } catch (e) {
      errors.push({ collection: 'users.stats', error: (e && e.message) || 'RESET_STATS_FAILED' })
    }

    if (!targets.includes('checkins')) {
      try {
        removed.checkins = await purge('checkins')
      } catch (e) {
        errors.push({ collection: 'checkins', error: (e && e.message) || 'PURGE_FAILED' })
      }
    }
  }

  const after = await snapshot()

  return {
    code: 0,
    data: {
      mode: 'purge',
      targets,
      rejected: rejected.length ? rejected : undefined,
      removed,
      cursorReset,
      statsReset: event.resetStats === true ? statsReset : undefined,
      before,
      after,
      errors: errors.length ? errors : undefined,
      next: '词库已清空。接下来：① seed_words 导入新词表 → ② seed_audio 重新点亮 audioReady'
    }
  }
}
