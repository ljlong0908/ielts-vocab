/**
 * seed_audio —— 音频批量入库（管理用）
 *
 * ⚠️ 安全：云函数是「对全体用户开放的接口」，任何小程序用户都能调它。
 *    本函数会写入云存储、audio_cache 与 words，故必须携带管理密钥。
 *
 * 支持两类音频：
 *   1. 单词音频（默认）—— items 用 word 字段
 *      { "_token": "...", "items": [{ "word": "abandon", "type": 2, "base64": "..." }] }
 *   2. 例句音频 —— items 用 kind:"sentence" + text 字段（整句英文）
 *      { "_token": "...", "items": [{ "kind": "sentence", "text": "The council ...", "type": 2, "base64": "..." }] }
 *
 * 一次调用完成的事：
 *   1. 把 base64 音频上传到云存储 audio/{type}/{文件名}.mp3
 *   2. upsert audio_cache 集合 { text, type, fileID } —— 运行时查这里即命中，
 *      命中后 audio_cache 云函数直接返回 fileID，绝不外呼任何第三方
 *   3. 【仅单词】把 words 中同名词的 audioReady 置 true
 *      —— start_new_words 只取 audioReady 的词，从而「没有读音的词不会出现在学习中」。
 *      例句不参与出词，故不做这一步。
 *
 * 文件名规则：
 *   单词 → slug(word)      例：audio/2/council.mp3
 *   例句 → s_{hash(text)}  例：audio/2/s_1a2b3c.mp3
 *   ⚠️ 例句**不能**用 slug：整句长达数十字符，转 slug 会超长，且句末标点被替换为空后
 *      极易碰撞。hash 算法必须与 scripts/gen_sentence_audio.py 的 hash_text() 严格一致
 *      （JS int32 语义）。
 *
 * 用法（分批调用，建议每批 base64 总量 ≤350KB）：
 *   单词：单次 ≤80 条
 *   例句：单条约 20–40KB 音频 → base64 约 30–55KB，单批 6–10 条为宜
 *
 * 返回：{ received, uploaded, cached, updated, marked, sentences, failed: [...] }
 *
 * 依赖集合：audio_cache（text, type, fileID, source, bytes, kind, createdAt）
 * 依赖云存储路径：audio/{type}/{文件名}.mp3
 *
 * 配套本地脚本：
 *   单词：build_wordlist.py → gen_audio.py → pack_audio.py
 *   例句：gen_examples.py  → gen_sentence_audio.py → pack_audio.py
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const audioCache = db.collection('audio_cache')
const words = db.collection('words')

// 管理密钥：必须配置，未配置时本函数拒绝一切调用（安全默认）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

// 与 audio_cache 云函数保持一致的入参口径
const TEXT_RE = /^[A-Za-z][A-Za-z'\u2019\- ]{0,39}$/                       // 单词/短语
// 例句：字母开头，长度 1–200，允许「除控制字符 / 反斜杠 / 反引号」外的可打印字符。
// 刻意用**排除集**而非逐个列举标点：真实例句里出现过 `%`（"over 70% of the
// country's GDP"），白名单每漏一个标点，对应例句的音频就查不到；且这条正则要在
// seed_audio / audio_cache / make_audition_page 三处保持同步，白名单极易漏改。
const TEXT_RE_SENTENCE = /^[A-Za-z][^\x00-\x1F\x7F\\`]{0,199}$/

const MAX_ITEMS = 80          // 单次调用最多处理多少条
const MAX_B64_LEN = 600000    // 单条 base64 长度上限（约 440KB 原始音频）
const MARK_CHUNK = 50         // words 批量置位时的分片大小

/** 云存储文件名 slug，与 scripts/gen_audio.py 的 slug() 保持一致 */
function slug(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return s || 'x'
}

/**
 * 字符串 hash（JS int32 语义），生成合规且长度可控的文件名。
 * ⚠️ 必须与 scripts/gen_sentence_audio.py 的 hash_text() 算出相同的值。
 */
function hashText(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h).toString(36)
}

/** 例句音频的云存储文件名（s_ 前缀与单词音频区分） */
function sentenceSlug(text) {
  return 's_' + hashText(text)
}

exports.main = async (event = {}) => {
  // ⚠️ 鉴权：先判空再比较，避免「密钥未配置 + 调用方也不传」被误判为通过
  if (!ADMIN_TOKEN) {
    return { code: -1, message: 'ADMIN_TOKEN_NOT_CONFIGURED：请先在云函数环境变量中配置 ADMIN_TOKEN' }
  }
  if (event._token !== ADMIN_TOKEN) {
    return { code: -1, message: 'INVALID_ADMIN_TOKEN：未授权调用（管理函数只允许持有密钥的调用方使用）' }
  }

  const items = Array.isArray(event.items) ? event.items : []
  if (!items.length) return { code: -1, message: 'missing items' }
  if (items.length > MAX_ITEMS) {
    return { code: -1, message: `TOO_MANY_ITEMS：单次最多 ${MAX_ITEMS} 条，当前 ${items.length} 条` }
  }

  let uploaded = 0
  let cached = 0
  let updated = 0
  let sentenceCount = 0
  const failed = []
  const touchedWords = new Set()

  for (const it of items) {
    const isSentence = !!(it && it.kind === 'sentence')
    const type = Number(it && it.type) === 1 ? 1 : 2
    const b64 = (it && it.base64) || ''

    // 例句用 text（整句），单词用 word
    const raw = isSentence
      ? String((it && it.text) || '').trim()
      : String((it && it.word) || '').trim()

    try {
      if (isSentence) {
        if (!TEXT_RE_SENTENCE.test(raw)) throw new Error('INVALID_SENTENCE')
      } else if (!TEXT_RE.test(raw)) {
        throw new Error('INVALID_WORD')
      }
      if (typeof b64 !== 'string' || !b64.length) throw new Error('MISSING_BASE64')
      if (b64.length > MAX_B64_LEN) throw new Error('BASE64_TOO_LARGE')

      const buf = Buffer.from(b64, 'base64')
      if (!buf.length) throw new Error('EMPTY_AUDIO')

      // 1. 上传云存储
      const name = isSentence ? sentenceSlug(raw) : slug(raw)
      const cloudPath = `audio/${type}/${name}.mp3`
      const up = await cloud.uploadFile({ cloudPath, fileContent: buf })
      if (!up.fileID) throw new Error('UPLOAD_FAILED')
      uploaded++
      if (isSentence) sentenceCount++

      // 2. upsert audio_cache 索引（运行时命中即返回，不再外呼任何第三方）
      //    例句以整句文本为 key，与前端 playSentence 传入的文本一致
      const hit = await audioCache.where({ text: raw, type }).limit(1).get()
      if (hit.data[0]) {
        await audioCache.doc(hit.data[0]._id).update({
          data: {
            fileID: up.fileID,
            source: 'preseed',
            bytes: buf.length,
            kind: isSentence ? 'sentence' : 'word',
            updatedAt: new Date()
          }
        })
        updated++
      } else {
        await audioCache.add({
          data: {
            text: raw,
            type,
            fileID: up.fileID,
            source: 'preseed',
            bytes: buf.length,
            kind: isSentence ? 'sentence' : 'word',
            createdAt: new Date()
          }
        })
        cached++
      }

      // 例句不参与出词，无需点亮 audioReady
      if (!isSentence) touchedWords.add(raw)
    } catch (e) {
      failed.push({
        text: raw,
        type,
        kind: isSentence ? 'sentence' : 'word',
        error: (e && e.message) || 'SEED_AUDIO_FAILED'
      })
    }
  }

  // 3. 点亮：把本批涉及的**单词**在 words 中标记为「已有音频」
  //    只有 audioReady = true 的词才会被 start_new_words 取出进入学习
  let marked = 0
  const wordList = Array.from(touchedWords)
  for (let i = 0; i < wordList.length; i += MARK_CHUNK) {
    const chunk = wordList.slice(i, i + MARK_CHUNK)
    try {
      const r = await words
        .where({ word: _.in(chunk), audioReady: _.neq(true) })
        .update({ data: { audioReady: true, audioReadyAt: new Date() } })
      marked += (r && r.stats && r.stats.updated) || 0
    } catch (e) {
      // 单个分片失败不影响其余；即使全部失败，音频索引已写好，重跑即可
      failed.push({ text: chunk.join(','), type: 0, kind: 'word', error: `MARK_FAILED: ${(e && e.message) || ''}` })
    }
  }

  // 未在 words 中出现的词（音先生成、词表后导）不算错，仅提示
  const notInWords = []
  for (let i = 0; i < wordList.length; i += MARK_CHUNK) {
    const chunk = wordList.slice(i, i + MARK_CHUNK)
    try {
      const r = await words.where({ word: _.in(chunk) }).field({ word: true }).get()
      const found = new Set(r.data.map((d) => d.word))
      chunk.forEach((w) => { if (!found.has(w)) notInWords.push(w) })
    } catch (e) { /* 忽略：仅用于提示 */ }
  }

  return {
    code: 0,
    data: {
      received: items.length,
      uploaded,
      cached,
      updated,
      marked,
      sentences: sentenceCount,
      notInWords: notInWords.length ? notInWords : undefined,
      failed: failed.length ? failed : undefined
    }
  }
}
