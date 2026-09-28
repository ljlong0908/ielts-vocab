/**
 * audio_cache —— 音频服务端缓存（云存储，跨用户共享）
 *
 * 职责：为**单词**与**例句**两类音频提供全局缓存。
 *       两类文本走不同策略，这是本函数的核心设计：
 *
 *   单词（kind 缺省 / 'word'）：
 *     ① 查 audio_cache 集合（text + type）→ 命中直接返回 fileID
 *     ② 未命中 → 下载 dictvoice → 上传云存储 → 写索引 → 返回 fileID
 *        （首次下载即缓存，跨用户共享，之后不再外呼）
 *
 *   例句（kind === 'sentence'）：
 *     ① 查 audio_cache 集合 → 命中直接返回 fileID
 *     ② 未命中 → **直接返回失败，不调第三方、不写云存储**
 *        原因有二：
 *          a. dictvoice 对整句本就返回 null audio，兜底毫无意义；
 *          b. 若在此开放「下载 + 写存储」，就等于给任意长文本开了滥用口子
 *             （云函数对全体用户开放，入参可伪造，可被用来刷爆存储配额）。
 *        因此例句音频**只能由 seed_audio 预先上传**，本函数对例句只读不写。
 *
 * 入参：{ text: 'abandon', type: 2 }                            单词
 *       { text: 'The council approved ...', type: 2, kind: 'sentence' }  例句
 * 返回：{ code: 0, data: { fileID, cached: true/false } }
 *
 * 依赖集合：audio_cache（字段：text, type, fileID, source, bytes, kind, createdAt）
 * 依赖云存储路径：audio/{type}_{hash}.mp3（仅单词的 dictvoice 兜底路径使用）
 */
const cloud = require('wx-server-sdk')
const axios = require('axios')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const cache = db.collection('audio_cache')

/** 单词：以字母开头，由字母 / 空格 / 撇号 / 连字符组成，总长 1–40 字符 */
const TEXT_RE_WORD = /^[A-Za-z][A-Za-z'\u2019\- ]{0,39}$/

/** 例句：字母开头，长度 1–200，允许「除控制字符 / 反斜杠 / 反引号」外的可打印字符。
 *  刻意用排除集而非逐个列举标点：真实例句里出现过 `%`（"over 70% of ..."），
 *  白名单每漏一个标点，该例句的音频就查不到；且这条正则要与 seed_audio /
 *  make_audition_page 三处同步，白名单极易漏改。 */
const TEXT_RE_SENTENCE = /^[A-Za-z][^\x00-\x1F\x7F\\`]{0,199}$/

/** 简单字符串 hash，用于生成合规的云存储文件名（text 可能含空格/特殊字符） */
function hashText(text) {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h) + text.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h).toString(36)
}

exports.main = async (event = {}) => {
  const { text } = event
  if (!text || typeof text !== 'string') return { code: -1, message: 'missing text' }

  const t = text.trim()
  const isSentence = String(event.kind || '') === 'sentence'

  // ⚠️ 入参校验：本函数对单词会下载第三方音频并写入云存储。云函数对全体用户开放，
  //    若不限制入参，任何人可传任意文本循环调用，把云存储写满并触发 dictvoice 限流。
  const re = isSentence ? TEXT_RE_SENTENCE : TEXT_RE_WORD
  if (!re.test(t)) {
    return {
      code: -1,
      message: isSentence
        ? 'INVALID_SENTENCE: 例句需为英文句子（字母开头，≤200 字符）'
        : 'INVALID_TEXT: 仅接受英文单词/短语（字母开头，≤40 字符）'
    }
  }

  // type 收敛为 1(英音) / 2(美音)，阻断任意值造成的无效外呼与缓存碎片
  const type = Number(event.type) === 1 ? 1 : 2

  try {
    // 1. 查库索引（单词/例句都查；命中即返回，绝不调第三方）
    const r = await cache.where({ text: t, type }).get()
    if (r.data[0] && r.data[0].fileID) {
      return { code: 0, data: { fileID: r.data[0].fileID, cached: true } }
    }

    // 2. 例句：没有预置音频就到此为止，不做任何兜底（理由见文件头注释）
    if (isSentence) {
      return { code: -1, message: 'NOT_PRESEEDED: 例句音频需由 seed_audio 预先上传' }
    }

    // 3. 单词：dictvoice 兜底 —— 下载 → 上传云存储 → 写索引
    const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(t)}&type=${type}`
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5
    })
    if (!resp.data || !resp.data.length) {
      throw new Error('EMPTY_AUDIO_RESPONSE')
    }

    const cloudPath = `audio/${type}_${hashText(t)}.mp3`
    const upload = await cloud.uploadFile({
      cloudPath,
      fileContent: Buffer.from(resp.data)
    })
    if (!upload.fileID) throw new Error('UPLOAD_FAILED')

    // 并发时可能重复 add，按 text+type 查重容忍
    try {
      await cache.add({
        data: { text: t, type, fileID: upload.fileID, kind: 'word', source: 'dictvoice', createdAt: new Date() }
      })
    } catch (e) {
      // 并发重复添加忽略；下次查库命中即可
    }

    return { code: 0, data: { fileID: upload.fileID, cached: false } }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'AUDIO_CACHE_FAILED' }
  }
}
