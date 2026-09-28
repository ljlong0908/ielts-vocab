/**
 * enrich_word —— AI 内容补全（核心降本逻辑）
 *
 * 职责：为缺失扩展内容（例句/词根/词源）的单词调用大模型生成，
 *       通过内容安全检测后写回 words 集合，后续全局直接读取。
 *
 * 大模型：DeepSeek（deepseek-chat / DeepSeek-V3），OpenAI 兼容协议
 *
 * 两种触发方式：
 *   1. 被 word_card 云函数同步调用（用户首次学习该词）
 *   2. 定时触发器兜底重试（event.Type === 'Timer'）
 *
 * 并发控制：乐观锁 enrichStatus: pending → generating → ok / failed
 */
const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const words = db.collection('words')

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
// ⚠️ 敏感信息只从环境变量读取，禁止硬编码 Key（代码入库/分享会泄露）
// 在云开发控制台 → 云函数 enrich_word → 配置 → 环境变量 中配置 DEEPSEEK_API_KEY
const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const ENDPOINT = process.env.DEEPSEEK_ENDPOINT || 'https://api.deepseek.com/chat/completions'
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 30000)
// ⚠️ 管理密钥：云函数是「对全体用户开放的接口」，前端可伪造任意 event 参数。
//    只有持有此密钥的调用方（控制台云端测试 / 管理脚本）才能使用 force 强制重生成，
//    否则任何人循环调用 force:true 即可绕过缓存无限消耗 DeepSeek 余额。
//    在云函数环境变量中配置 ADMIN_TOKEN（建议 32 位以上随机串）。
//    未配置时视为「无管理通道」，force 一律忽略（安全默认）。
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''
const MAX_ATTEMPTS = 2 // JSON 解析失败时重试一次
const LOCK_TIMEOUT_MS = 60 * 1000
const RETRY_BATCH = 10

function buildPrompt(w) {
  return `你是雅思词汇教学专家。请为单词 "${w.word}"（词性 ${w.pos || '-'}，释义：${w.meaning || '-'}）生成学习卡片内容。
严格只返回一个 json 对象，不要输出任何多余文字、解释或 Markdown 代码块：
{
  "example": { "en": "英文例句（不超过20词）", "cn": "中文翻译" },
  "roots": [ { "part": "ab-", "type": "prefix", "meaning": "含义" } ],
  "etymology": "词源演变简述（不超过60字）"
}
要求：
1) 例句贴近雅思学术或生活场景；
2) 词根拆解要准确，type 取值 prefix/root/suffix；若该词无明显词根，roots 返回空数组 []；
3) 词源简明通俗。`
}

function stripFence(text) {
  return String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

/** 把 axios / DeepSeek 的报错转成可读信息，便于排查 */
function normalizeError(err) {
  if (err && err.response) {
    const status = err.response.status
    const body = err.response.data || {}
    const detail =
      (body.error && (body.error.message || body.error.type)) || body.message || JSON.stringify(body)
    const short = String(detail || '').slice(0, 200)
    if (status === 401) return new Error(`DEEPSEEK_AUTH_FAILED: ${short}`)
    if (status === 402) return new Error(`DEEPSEEK_INSUFFICIENT_BALANCE: ${short}`)
    if (status === 429) return new Error(`DEEPSEEK_RATE_LIMITED: ${short}`)
    return new Error(`DEEPSEEK_HTTP_${status}: ${short}`)
  }
  if (err && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || ''))) {
    return new Error('DEEPSEEK_TIMEOUT')
  }
  return err
}

async function callModel(w) {
  const resp = await axios.post(
    ENDPOINT,
    {
      model: MODEL,
      messages: [{ role: 'user', content: buildPrompt(w) }],
      temperature: 0.3,
      max_tokens: 800,
      stream: false,
      // DeepSeek JSON Output：强制返回合法 json，避免解析失败
      response_format: { type: 'json_object' }
    },
    {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS
    }
  )
  const choice = resp.data && resp.data.choices && resp.data.choices[0]
  const raw = (choice && choice.message && choice.message.content) || ''
  if (!raw) throw new Error('EMPTY_MODEL_RESPONSE')
  return raw
}

async function generate(w) {
  if (!API_KEY) throw new Error('MISSING_DEEPSEEK_API_KEY')

  let lastErr
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await callModel(w)
      const parsed = JSON.parse(stripFence(raw))
      return {
        example: parsed.example && parsed.example.en ? parsed.example : null,
        roots: Array.isArray(parsed.roots) ? parsed.roots.slice(0, 6) : [],
        etymology: typeof parsed.etymology === 'string' ? parsed.etymology : ''
      }
    } catch (err) {
      lastErr = normalizeError(err)
      // 网络/鉴权/余额类错误重试无意义，直接抛出
      if (!/EMPTY_MODEL_RESPONSE|JSON|Unexpected/i.test(lastErr.message || '')) throw lastErr
      console.warn(`[enrich] attempt ${attempt} failed:`, lastErr.message)
    }
  }
  throw lastErr
}

/** 内容安全检测：命中违规抛错；其它异常只记录不阻断（保证定时任务可运行） */
async function assertSafe(content, openid) {
  const text = [
    content.example && content.example.en,
    content.example && content.example.cn,
    content.etymology,
    ...(content.roots || []).map((r) => `${r.part || ''} ${r.meaning || ''}`)
  ]
    .filter(Boolean)
    .join('\n')
  if (!text) return
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: text.slice(0, 2500),
      version: 2,
      scene: 2,
      openid: openid || undefined
    })
    const suggest = res && res.result && res.result.suggest
    if (suggest && suggest !== 'pass') throw new Error('CONTENT_UNSAFE')
  } catch (err) {
    const code = String((err && (err.errCode || err.code)) || '')
    if (code === '87014' || /87014/.test(String((err && err.errMsg) || err.message || ''))) {
      throw new Error('CONTENT_UNSAFE')
    }
    console.warn('[msgSecCheck] skipped:', code, (err && err.errMsg) || err.message)
  }
}

/** 对单个单词执行「抢锁 → 生成 → 安全检测 → 写回」 */
async function enrichOne(wordId, force, openid) {
  let doc
  try {
    doc = await words.doc(wordId).get()
  } catch (e) {
    return { code: -1, message: 'word not found' }
  }
  const w = doc.data
  if (!w) return { code: -1, message: 'word not found' }
  if (w.enriched && !force) return { code: 0, data: { skipped: true } }

  const lockRes = await words
    .where({ _id: wordId, enrichStatus: _.neq('generating') })
    .update({ data: { enrichStatus: 'generating', enrichLockAt: new Date() } })

  if (!lockRes.stats || lockRes.stats.updated === 0) {
    return { code: 0, data: { locked: true } }
  }

  try {
      const content = await generate(w)
      await assertSafe(content, openid)
      // 用 _.set 整体替换对象/数组字段，避免 SDK 对嵌套对象做点操作
      // （当字段当前为 null 时，点操作会报 "Cannot create field 'x' in element {y: null}"）
      await words.doc(wordId).update({
        data: {
          example: _.set(content.example),
          roots: _.set(content.roots),
          etymology: content.etymology,
          enriched: true,
          enrichStatus: 'ok',
          enrichedAt: new Date(),
          enrichError: ''
        }
      })
    return { code: 0, data: { enriched: true } }
  } catch (err) {
    await words.doc(wordId).update({
      data: {
        enrichStatus: 'failed',
        enrichError: String((err && err.message) || err).slice(0, 300)
      }
    })
    return { code: -1, message: (err && err.message) || 'ENRICH_FAILED' }
  }
}

/** 定时任务：释放超时锁 + 批量重试失败/待处理词条 */
async function retryBatch() {
  const stale = new Date(Date.now() - LOCK_TIMEOUT_MS)
  await words
    .where({ enrichStatus: 'generating', enrichLockAt: _.lt(stale) })
    .update({ data: { enrichStatus: 'pending' } })

  const pending = await words
    .where({ enriched: false, enrichStatus: _.in(['pending', 'failed']) })
    .limit(RETRY_BATCH)
    .get()

  let ok = 0
  for (const item of pending.data) {
    const r = await enrichOne(item._id, false, null)
    if (r && r.code === 0 && r.data && r.data.enriched) ok++
  }
  return { code: 0, data: { processed: pending.data.length, ok } }
}

exports.main = async (event = {}) => {
  if (event && event.Type === 'Timer') {
    return retryBatch()
  }
  const { OPENID } = cloud.getWXContext()
  const { wordId } = event
  if (!wordId) return { code: -1, message: 'missing wordId' }

  // ⚠️ force 直接来自 event，而 event 是客户端可伪造的，不能无条件信任。
  //    仅当调用方携带正确的管理密钥时才允许强制重生成（绕过 enriched 缓存）。
  //    未配置 ADMIN_TOKEN 时 isAdmin 恒为 false，即安全默认：force 失效。
  //    注意必须先用 ADMIN_TOKEN 非空判断，否则「双方都是空字符串」会误判为通过。
  const isAdmin = !!ADMIN_TOKEN && event._token === ADMIN_TOKEN
  const force = isAdmin && event.force === true
  if (event.force && !isAdmin) {
    console.warn('[enrich] force 被忽略：调用方未通过管理密钥校验')
  }

  try {
    return await enrichOne(wordId, force, OPENID)
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'ENRICH_FAILED' }
  }
}
