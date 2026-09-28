/**
 * init_db —— 云数据库一键体检 / 初始化（管理用，幂等）
 *
 * 为什么需要它：云开发的集合必须先「存在」才能读写，否则云函数直接抛
 * `Db not exist` / `database collection not exists`。本项目共 7 个集合，
 * 在控制台逐个手建容易漏一两个，然后运行时才炸。这个函数把这一步变成一条命令。
 *
 * 入参：
 *   { _token, mode?: 'preview' | 'create', collections?: string[] }
 *   - 不传 mode → 'preview'：只体检，不写任何数据
 *   - mode:'create'：创建缺失的集合（已存在的自动跳过）
 *   - collections：只处理指定集合（默认全部）
 *
 * 出参（data）：
 *   { mode, total, created[], missing[], ready, collections{name:{exists,docs}},
 *     descriptions[], indexes[] }
 *
 * ⚠️ 边界（SDK 做不到、仍需手工）：
 *   1. 云开发 SDK **只能建集合，不能建索引** → 返回体的 `indexes` 是手工清单
 *   2. 集合的**安全规则**也只能在控制台设（建议 words「所有用户可读」，其余「仅创建者可读写」）
 *
 * 配套：docs/deploy.md「第 6 步：初始化数据表」。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 项目需要的全部集合（与 docs/project-spec.md §4 一一对应） */
const EXPECTED = [
  { name: 'users', desc: '用户：openid / 每日目标 / streak / 出词游标 wordCursor' },
  { name: 'words', desc: '词库 + AI 内容缓存：seq 出词序号、audioReady 音频就绪' },
  { name: 'user_words', desc: '用户单词学习状态：复习调度核心（status / nextReviewDate）' },
  { name: 'daily_plans', desc: '每日计划与状态机：reviewQueue / practiceQueue（含答案，不下发）' },
  { name: 'records', desc: '答题流水：错题本来源' },
  { name: 'checkins', desc: '打卡记录：日历与 streak' },
  { name: 'audio_cache', desc: '音频索引（跨用户共享）：单词与例句共用，键为 text + type' }
]

/** 必须在控制台手工创建的索引（SDK 不支持建索引） */
const INDEXES = [
  { collection: 'users', index: '_openid', unique: true, note: '登录时按 openid 查用户' },
  { collection: 'words', index: 'word', unique: true, note: 'seed_words 导入去重；seed_audio 按词名点亮' },
  { collection: 'words', index: 'audioReady(升序) + seq(升序)', unique: false, note: '★ 出词：audioReady=true 且 seq 递增' },
  { collection: 'user_words', index: '_openid + wordId', unique: true, note: '学习状态读写' },
  { collection: 'user_words', index: '_openid + status + nextReviewDate', unique: false, note: '复习池查询（每日首次进流程）' },
  { collection: 'daily_plans', index: '_openid + date', unique: true, note: '当日计划唯一' },
  { collection: 'records', index: '_openid + date', unique: false, note: '答题记录按日查' },
  { collection: 'records', index: '_openid + isCorrect', unique: false, note: '错题本' },
  { collection: 'checkins', index: '_openid + date', unique: true, note: '打卡幂等判定' },
  { collection: 'audio_cache', index: 'text + type', unique: true, note: '音频索引唯一，命中即返回 fileID' }
]

/** 集合已存在时各 SDK 版本返回不同错误码/文案，统一识别为「已存在」 */
function isExistsError(e) {
  const msg = String((e && (e.errCode || e.errMsg || e.message)) || '')
  return /already exist|CollectionExists|-501001|DATABASE_COLLECTION_EXIST/i.test(msg)
}

/** 探测单个集合：能 count 出来即视为存在（顺带拿到文档数） */
async function probe(name) {
  try {
    const r = await db.collection(name).count()
    return { exists: true, docs: r.total || 0 }
  } catch (e) {
    return { exists: false, docs: 0 }
  }
}

exports.main = async (event = {}) => {
  // 环境变量是函数级隔离的，本函数需单独配置 ADMIN_TOKEN（与其他管理函数同值）
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN
  if (!ADMIN_TOKEN) return { code: -1, message: 'ADMIN_TOKEN_NOT_CONFIGURED' }
  if (!event._token || event._token !== ADMIN_TOKEN) {
    return { code: -1, message: 'INVALID_ADMIN_TOKEN' }
  }

  const mode = event.mode === 'create' ? 'create' : 'preview'
  const all = EXPECTED.map((x) => x.name)
  const names = Array.isArray(event.collections) && event.collections.length
    ? event.collections.filter((n) => all.includes(n))
    : all

  if (!names.length) return { code: -1, message: 'NO_VALID_COLLECTION' }

  try {
    const created = []
    if (mode === 'create') {
      for (const n of names) {
        const cur = await probe(n)
        if (cur.exists) continue
        try {
          await db.createCollection(n)
          created.push(n)
        } catch (e) {
          if (!isExistsError(e)) {
            const detail = (e && (e.errMsg || e.message)) || String(e)
            return { code: -1, message: `CREATE_FAILED:${n}:${detail}` }
          }
        }
      }
    }

    // 无论 preview 还是 create，最终都以一次真实探测为准（create 后立即复查）
    const collections = {}
    for (const n of names) {
      collections[n] = await probe(n)
    }
    const missing = names.filter((n) => !collections[n].exists)

    return {
      code: 0,
      data: {
        mode,
        total: names.length,
        created,
        missing,
        ready: missing.length === 0,
        collections,
        descriptions: EXPECTED.filter((x) => names.includes(x.name)),
        indexes: INDEXES.filter((x) => names.includes(x.collection))
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'INIT_DB_FAILED' }
  }
}
