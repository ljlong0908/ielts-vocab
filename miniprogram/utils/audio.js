/**
 * 单词 / 例句发音：三层缓存（前端 fileID → 云存储 → dictvoice 兜底）
 *
 * 缓存层：
 *   1. 前端 wx.storage 存 fileID → 命中秒播，不联网
 *   2. 云存储 + audio_cache 集合（跨用户共享）→ 全局每段文本只下载/合成一次
 *   3. dictvoice 最终源 → **仅单词**在云存储无缓存时兜底
 *
 * ⚠️ 单词与例句的差别（重要）：
 *   单词：音频由本地 Kokoro 预生成 → seed_audio 上传 → 云存储；
 *         词表外的词仍走 dictvoice 兜底，保证任何词都能发音。
 *   例句：文本由 AI 生成，音频同样本地预生成上传；**没有兜底**——
 *         整句 dictvoice 必返回 null，且放开会让任意长文本可写云存储。
 *         未预置音频时静默不播（补音频期间大量例句没有音频，弹提示会持续打扰）。
 *         详见 docs/project-spec.md §7.9。
 *
 * 流程：
 *   play(text) → 查前端缓存 fileID
 *     ├─ 命中 → InnerAudioContext.src = fileID → 播放
 *     └─ 未命中 → 调 audio_cache 云函数拿 fileID → 缓存 fileID → 播放
 *                   └─ 单词：云函数失败则降级直接播 dictvoice URL
 *
 * ⚠️ 需在小程序后台配置 downloadFile 合法域名：https://dict.youdao.com
 */
const config = require('../config')

const CACHE_PREFIX = 'audio_cache_'

let audioCtx = null

function getCtx() {
  if (!audioCtx) {
    audioCtx = wx.createInnerAudioContext()
    audioCtx.obeyMuteSwitch = false
  }
  return audioCtx
}

function langToType(lang) {
  const l = (lang || config.TTS_LANG || 'en_US').toLowerCase()
  if (l === 'en_gb' || l === 'gb') return 1
  return 2
}

function cacheKey(text, type) {
  return `${CACHE_PREFIX}${type}_${text}`
}

/** 查前端缓存的 fileID */
function getCache(text, type) {
  return new Promise((resolve) => {
    wx.getStorage({
      key: cacheKey(text, type),
      success: (res) => resolve(res.data && res.data.fileID),
      fail: () => resolve(null)
    })
  })
}

/** 存前端缓存（fileID） */
function setCache(text, type, fileID) {
  wx.setStorage({
    key: cacheKey(text, type),
    data: { fileID, ts: Date.now() }
  })
}

/**
 * 调 audio_cache 云函数拿 fileID
 * 命中云存储直接返回；单词未命中时由云函数下载 dictvoice 并缓存
 * @param {'word'|'sentence'} kind 例句必须显式传 'sentence'
 */
function fetchFromServer(text, type, kind) {
  return new Promise((resolve) => {
    const data = { text, type }
    if (kind === 'sentence') data.kind = 'sentence'

    wx.cloud.callFunction({
      name: config.FN.AUDIO_CACHE,
      data,
      success: (res) => {
        const r = (res && res.result) || {}
        if (r.code === 0 && r.data && r.data.fileID) {
          resolve(r.data.fileID)
        } else {
          resolve(null)
        }
      },
      fail: () => resolve(null)
    })
  })
}

/** dictvoice 兜底 URL（仅单词使用；例句不做兜底） */
function fallbackUrl(text, type) {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${type}`
}

/**
 * 内部：获取播放源（三层缓存：前端 → 云存储 → dictvoice 兜底）
 * @param {'word'|'sentence'} kind
 */
async function resolveSrc(text, type, kind) {
  // 1. 查前端缓存
  let src = await getCache(text, type)

  // 2. 未命中 → 调云函数拿 fileID
  if (!src) {
    src = await fetchFromServer(text, type, kind)
    if (src) setCache(text, type, src)
  }

  // 3. 单词：云函数也失败 → 降级 dictvoice URL
  //    例句：不兜底（整句 dictvoice 必失败），返回 null 由调用方处理
  if (!src && kind !== 'sentence') {
    src = fallbackUrl(text, type)
  }
  return src
}

/**
 * 内部：把 src 交给 InnerAudioContext 播放
 * 统一「先停 → 清旧监听 → 设源 → 播放 → 挂 onError」，避免单词/例句两条路径各写一遍。
 */
function playSrc(src, failMsg) {
  const ctx = getCtx()
  ctx.stop()
  ctx.offEnded && ctx.offEnded()
  ctx.offError && ctx.offError()
  ctx.src = src
  ctx.play()
  ctx.onError(() => {
    wx.showToast({ title: failMsg, icon: 'none' })
  })
}

/** 播放单词发音 */
function playWord(word, lang) {
  if (!word) return
  const type = langToType(lang)
  resolveSrc(word, type, 'word').then((src) => playSrc(src, '发音加载失败'))
}

/**
 * 播放整句例句发音
 *
 * 音频由本地 Kokoro 预生成（scripts/gen_examples.py → gen_sentence_audio.py
 * → seed_audio 上传），以**整句英文文本**为 key 存在 audio_cache 里。
 *
 * 早期实现是「按空格拆词逐个播放单词音频」，读出来是生硬的逐词蹦字；
 * 现在改为整句音频后语流自然。未预置音频时静默返回——补音频是渐进的，
 * 期间大量例句尚无音频，弹提示会持续打扰学习。
 */
function playSentence(text, lang) {
  if (!text) return
  const type = langToType(lang)
  resolveSrc(text, type, 'sentence').then((src) => {
    if (!src) return // 未预置例句音频：静默跳过
    playSrc(src, '例句发音加载失败')
  })
}

/** 停止播放 */
function stop() {
  if (audioCtx) {
    audioCtx.stop()
    audioCtx.offEnded && audioCtx.offEnded()
    audioCtx.offError && audioCtx.offError()
  }
}

module.exports = { playWord, playSentence, stop }
