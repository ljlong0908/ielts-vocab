/**
 * 单词 / 例句发音：四层缓存 + 全站预加载
 *
 * 为什么需要它：早先每次发声都要「查云端 → 换临时链接 → 下载 → 播」，
 * 首次进页、翻到下一个词、切到练习页时都要重走一遍，听感就是「点了没声音，
 * 过一会儿才响」。现在把音频文件落到**本地**，并让有声页面提前异步预载。
 *
 * 缓存层（就近优先）：
 *   L0 内存 memo              —— 本次运行已就绪的文本，命中即免网络
 *   L1 本地文件（USER_DATA_PATH/audio/*.mp3）—— 持久、跨启动，零网络，**秒播**
 *   L2 云存储 fileID（audio_cache 集合，跨用户共享）
 *   L3 dictvoice 直链         —— **仅单词**兜底（词表外的词也能发音）
 *
 * 播放策略（`playText`）：
 *   L1 命中 → 直接播本地路径；
 *   未命中 → 立刻用远端起播（与旧行为一致，首播不因落盘而变慢），
 *            同时**后台**把远端落盘，下一次即走 L1 秒播。
 *   预加载（`preloadWords` / `preloadSentences`）则只落盘不播，把「下一次」提前到「这一次」。
 *
 * ⚠️ 单词与例句的差别（重要）：
 *   单词：音频由本地 Kokoro 预生成 → seed_audio 上传 → 云存储；
 *         词表外的词仍走 dictvoice 兜底，保证任何词都能发音。
 *   例句：文本由 AI 生成，音频同样本地预生成上传；**没有兜底**——
 *         整句 dictvoice 必返回 null，且放开会让任意长文本可写云存储。
 *         未预置音频时静默不播（补音频期间大量例句没有音频，弹提示会持续打扰）。
 *         详见 docs/project-spec.md §7.9。
 *
 * ⚠️ 最后一步「cloud:// → https」不能省：fileID 直填 src 真机会播到一半截断。
 *    走本地文件则绕开了这个问题（本地路径不做转换）。
 *
 * ⚠️ 需在小程序后台配置 downloadFile 合法域名：https://dict.youdao.com
 */
const config = require('../config')
const mock = require('./mock')

/* ================= 常量 ================= */

const CACHE_PREFIX = 'audio_cache_'
/** 本地缓存索引（LRU 淘汰用）的 storage key */
const INDEX_KEY = 'audio_local_index_v1'
/** USER_DATA_PATH 下的子目录名 */
const LOCAL_DIR = 'audio'

/**
 * 本地音频缓存总上限。
 * 依据：官方文档「本地缓存文件 + 本地用户文件共计最多 200MB」，超了**写入直接失败**，
 * 且平台不会自动清理。留足余量取 50MB —— 按实测体积（单词 ~4KB、例句 ~22KB）
 * 足够放下数千个词，正常使用几乎不会触发淘汰。
 */
const LOCAL_MAX_BYTES = 50 * 1024 * 1024
/** 淘汰水位：触发时回收到上限的 80%，避免每次写入都淘汰一次 */
const LOCAL_KEEP_RATIO = 0.8
/** 运行期实际使用的上限（`_setLocalMaxBytes` 仅给测试下调用，见文件尾导出） */
let localMaxBytes = LOCAL_MAX_BYTES
/** 预加载并发数：音频只有几 KB，3 路足够快又不至于抢满带宽/并发配额 */
const PRELOAD_CONCURRENCY = 3
/** 单次预加载任务上限：防止调用方一口气塞几百条。
 *  取 40 = 练习页一组题（题干 + 4 个英文选项）的量级，正好够用又不至于失控。 */
const PRELOAD_MAX_ITEMS = 40
/** LRU 索引写盘节流，避免每落一个文件就整表写一次 storage */
const INDEX_FLUSH_MS = 1500

/* ================= 运行时状态 ================= */

let audioCtx = null

/** key → { local, remote, saving }；本次运行的就绪表。
 *  ⚠️ 存的是**对象引用**：saveToLocal 完成后回填 m.local，让后续播放自动走本地。 */
const memo = {}
/** key → Promise：并发合并。播放与预加载同时要同一段文本时，只跑一次网络。 */
const pending = {}

/** 预加载队列（FIFO），running 为在跑数量 */
const queue = []
let running = 0

let dirReady = false
/** 索引内存副本：null = 尚未从 storage 读出 */
let indexMemo = null
let indexTimer = null
let indexDirty = false
let warmedUp = false

/* ================= 基础工具 ================= */

function fs() {
  return wx.getFileSystemManager()
}

function localDir() {
  return `${wx.env.USER_DATA_PATH}/${LOCAL_DIR}`
}

function isCloudId(src) {
  return typeof src === 'string' && src.indexOf('cloud://') === 0
}

function keyOf(text, type) {
  return `${type}_${text}`
}

function langToType(lang) {
  const l = (lang || config.TTS_LANG || 'en_US').toLowerCase()
  if (l === 'en_gb' || l === 'gb') return 1
  return 2
}

/**
 * 本地缓存文件名用的短哈希（**仅前端本地用**）。
 * ⚠️ 这不是跨运行时的 `hashText`（那份必须 Python/JS 完全一致，见 scripts/text_key.py）；
 *    这里只是给本地文件起个合法文件名，改动不影响线上任何数据。
 *    两个独立初值的哈希拼接，把碰撞概率压到可忽略（单哈希 32 位在数千条量级仍有 0.1% 风险，
 *    一旦碰撞就是「A 词播出 B 词的声音」这种极难排查的错误）。
 */
function localHash(text) {
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = ((h1 << 5) + h1 + c) | 0
    h2 = ((h2 << 5) - h2 + c) | 0
  }
  // 用 '-' 分隔两段：直接拼接会出现「ab+c」与「a+bc」都变 abc 的歧义
  return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`
}

function localPathFor(text, type) {
  return `${localDir()}/${type}_${localHash(text)}.mp3`
}

function ensureDir() {
  if (dirReady) return
  try {
    fs().mkdirSync(localDir(), true)
  } catch (e) {
    // 目录已存在会抛错，忽略即可
  }
  dirReady = true
}

function exists(path) {
  if (!path) return false
  try {
    fs().accessSync(path)
    return true
  } catch (e) {
    return false
  }
}

function fileSize(path) {
  try {
    const s = fs().statSync(path)
    return (s && s.size) || 0
  } catch (e) {
    return 0
  }
}

/* ================= storage 记录（每段文本一条） ================= */

/** 查某段文本的缓存记录：{ fileID, url, local, size, ts } */
function getRec(text, type) {
  return new Promise((resolve) => {
    wx.getStorage({
      key: CACHE_PREFIX + keyOf(text, type),
      success: (res) => resolve(res.data || null),
      fail: () => resolve(null)
    })
  })
}

function setRec(text, type, data) {
  try {
    wx.setStorage({ key: CACHE_PREFIX + keyOf(text, type), data })
  } catch (e) {
    // storage 写失败（配额满）不影响播放，本地文件仍在
  }
}

/* ================= 本地缓存索引 + LRU 淘汰 ================= */

function readIndexRaw() {
  try {
    const v = wx.getStorageSync(INDEX_KEY)
    if (Array.isArray(v)) return v
  } catch (e) {
    // 读失败按空表处理
  }
  return []
}

/**
 * 取索引（只读一次，之后走内存）。
 *
 * ⚠️ 这里**刻意不做**「逐个 accessSync 校验文件还在不在」的开工扫描：
 *    accessSync 是同步 JSBridge 调用，索引攒到几百条时一次扫描就够把
 *    「第一次点喇叭」卡住上百毫秒 —— 正是本次要消灭的那种等待。
 *    脏行改为**按需精确清理**，代价是 O(1)：
 *      · 读记录时发现文件不在（doPrepare 里 exists 已判过）→ indexDrop
 *      · 淘汰时 unlink 失败 → 那一行本来就是死的，直接从索引剔掉
 *    兜底：真出现「整表都是脏行」，一轮淘汰就会把它们全剔掉（unlink 失败即剔）。
 */
function loadIndex() {
  if (indexMemo) return indexMemo
  indexMemo = readIndexRaw().filter((x) => x && x.p)
  return indexMemo
}

function flushIndex(immediate) {
  if (!indexDirty) return
  if (indexTimer) clearTimeout(indexTimer)
  const doFlush = () => {
    indexTimer = null
    indexDirty = false
    try {
      wx.setStorageSync(INDEX_KEY, indexMemo || [])
    } catch (e) {
      // 索引只是淘汰用的账本，写失败不影响播放（下次读不到就当空表重建）
    }
  }
  if (immediate) doFlush()
  else indexTimer = setTimeout(doFlush, INDEX_FLUSH_MS)
}

function indexAdd(path, key, size) {
  if (!path) return
  const idx = loadIndex()
  const at = idx.findIndex((x) => x.p === path)
  const row = { p: path, k: key, s: size || 0, t: Date.now() }
  if (at >= 0) idx[at] = row
  else idx.push(row)
  indexDirty = true
  flushIndex()
}

/** 命中本地文件时刷新 LRU 时间（只改内存，靠节流批量落盘） */
function indexTouch(path) {
  const idx = loadIndex()
  const row = idx.filter((x) => x.p === path)[0]
  if (!row) return
  row.t = Date.now()
  indexDirty = true
  flushIndex()
}

/** 精确剔掉一条已知失效的索引行（文件已被系统回收） */
function indexDrop(path) {
  const idx = loadIndex()
  const at = idx.findIndex((x) => x.p === path)
  if (at < 0) return
  idx.splice(at, 1)
  indexDirty = true
  flushIndex()
}

function clearRecLocal(key) {
  if (!key) return
  try {
    wx.getStorage({
      key: CACHE_PREFIX + key,
      success: (res) => {
        const d = res.data
        if (d && d.local) {
          delete d.local
          delete d.size
          wx.setStorage({ key: CACHE_PREFIX + key, data: d })
        }
      },
      fail: () => {}
    })
  } catch (e) {
    // 忽略
  }
}

/** 超出上限时按 LRU（t 最小）删到 80% 水位 */
function evict() {
  const idx = loadIndex()
  let total = 0
  for (let i = 0; i < idx.length; i++) total += idx[i].s || 0
  if (total <= localMaxBytes) return
  idx.sort((a, b) => a.t - b.t)
  const keep = localMaxBytes * LOCAL_KEEP_RATIO
  while (idx.length && total > keep) {
    const row = idx.shift()
    try {
      fs().unlinkSync(row.p)
    } catch (e) {
      // 文件早已不在（系统回收过）—— 这一行本来就是脏的，剔掉即可
    }
    clearRecLocal(row.k)
    delete memo[row.k]
    total -= row.s || 0
  }
  indexDirty = true
  flushIndex(true)
}

/* ================= 远端取源 ================= */

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
        if (r.code === 0 && r.data && r.data.fileID) resolve(r.data.fileID)
        else resolve(null)
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
 * cloud:// fileID → 临时 HTTPS 链接（带内存级 TTL 缓存）
 *
 * ⚠️ 必须转换的原因（真机踩坑）：InnerAudioContext.src 直接填 cloud:// fileID
 *    在开发者工具里正常，**真机上会播放中途截断**（实测：每日一句第一次播两个词就停，
 *    第二次点因内部缓存才播完整）。转成 getTempFileURL 的 https 临时链接后稳定。
 *    临时链接有效期 2 小时 → 缓存 100 分钟，过期自动重取。
 *
 * 本地文件落盘后走不到这里；只有「本地化失败」的降级路径才用得上。
 */
const TEMP_URL_TTL = 100 * 60 * 1000
const tempUrlMemo = {} // fileID → { url, ts }

function toTempUrl(src) {
  if (!isCloudId(src)) return Promise.resolve(src) // dictvoice https / 本地路径原样透传
  const hit = tempUrlMemo[src]
  if (hit && Date.now() - hit.ts < TEMP_URL_TTL) return Promise.resolve(hit.url)
  return new Promise((resolve) => {
    wx.cloud.getTempFileURL({
      fileList: [src],
      success: (res) => {
        const f = (res && res.fileList && res.fileList[0]) || {}
        if (f.tempFileURL) {
          tempUrlMemo[src] = { url: f.tempFileURL, ts: Date.now() }
          resolve(f.tempFileURL)
        } else {
          resolve(src) // 转换失败退回 fileID：宁可冒截断风险也不哑掉
        }
      },
      fail: () => resolve(src)
    })
  })
}

/* ================= 落盘 ================= */

/** 远端（cloud:// fileID 或 https）→ 本地临时文件路径 */
function downloadToTemp(remote) {
  return new Promise((resolve) => {
    if (isCloudId(remote)) {
      wx.cloud.downloadFile({
        fileID: remote,
        success: (res) => resolve((res && res.tempFilePath) || null),
        fail: () => resolve(null)
      })
      return
    }
    wx.downloadFile({
      url: remote,
      success: (res) => resolve(res && res.statusCode === 200 ? res.tempFilePath : null),
      fail: () => resolve(null)
    })
  })
}

/** 临时文件 → 持久本地文件（返回真实可播路径） */
function persist(tempFilePath, text, type) {
  const dest = localPathFor(text, type)
  ensureDir()
  try {
    fs().unlinkSync(dest) // saveFile 不覆盖已存在文件，先删掉同名旧文件
  } catch (e) {
    // 不存在就忽略
  }
  return new Promise((resolve) => {
    fs().saveFile({
      tempFilePath,
      filePath: dest,
      success: (res) => resolve((res && res.savedFilePath) || dest),
      fail: () => {
        // 极少数基础库对自定义 filePath 支持不佳 → 退回 copyFile
        try {
          fs().copyFile({
            srcPath: tempFilePath,
            destPath: dest,
            success: () => resolve(dest),
            fail: () => resolve(null)
          })
        } catch (e) {
          resolve(null)
        }
      }
    })
  })
}

/**
 * 内部：把一段远端音频落到本地并登记。
 * 全程静默失败 —— 本地缓存是**加速手段**，不是功能前提；
 * 落盘失败（配额满、断网）只应表现为「下次还得联网」，绝不能打断播放。
 */
async function saveToLocal(remote, text, type, key) {
  try {
    const temp = await downloadToTemp(remote)
    if (!temp) return null
    const path = await persist(temp, text, type)
    if (!path) return null

    const size = fileSize(path)
    const m = memo[key]
    if (m) m.local = path

    const cloudFile = isCloudId(remote)
    setRec(text, type, {
      fileID: cloudFile ? remote : '',
      url: cloudFile ? '' : remote,
      local: path,
      size,
      ts: Date.now()
    })
    indexAdd(path, key, size)
    evict()
    return path
  } catch (e) {
    return null
  }
}

/* ================= 就绪表 ================= */

async function doPrepare(text, type, kind, key) {
  const m = { local: null, remote: null, saving: null }

  const rec = await getRec(text, type)
  if (rec) {
    m.remote = rec.fileID || rec.url || null
    if (exists(rec.local)) {
      m.local = rec.local
    } else if (rec.local) {
      // 记录说「本地有」，文件却已经不在（系统回收过）→ 记下这个事实：
      // 索引里那一行是脏的，顺手剔掉，免得它一直占着淘汰额度。
      indexDrop(rec.local)
    }
  }
  if (m.local) {
    memo[key] = m
    indexTouch(m.local)
    return m
  }

  if (!m.remote) {
    const fileID = await fetchFromServer(text, type, kind)
    if (fileID) m.remote = fileID
  }
  // 单词：云函数也失败 → 降级 dictvoice；
  // 例句：不兜底（整句 dictvoice 必失败），remote 仍为 null 由调用方静默处理
  if (!m.remote && kind !== 'sentence') m.remote = fallbackUrl(text, type)

  memo[key] = m
  if (m.remote) m.saving = saveToLocal(m.remote, text, type, key)
  return m
}

/**
 * 内部：把一段文本准备到「可播」态，返回 { local, remote, saving }。
 * 同一段文本并发调用只跑一次网络（播放与预加载经常同时要它）。
 */
function prepare(text, type, kind) {
  const key = keyOf(text, type)
  if (memo[key]) return Promise.resolve(memo[key])
  if (pending[key]) return pending[key]

  const task = doPrepare(text, type, kind, key).then(
    (m) => {
      delete pending[key]
      return m
    },
    () => {
      delete pending[key]
      // ⚠️ 失败**不写 memo**：失败可能是暂时的（云函数超时/断网），
      //    写进去会把「这次没拿到」变成「永久没有」，之后再点喇叭永远哑掉。
      return { local: null, remote: null, saving: null }
    }
  )
  pending[key] = task
  return task
}

/* ================= 播放 ================= */

function getCtx() {
  if (!audioCtx) {
    audioCtx = wx.createInnerAudioContext()
    audioCtx.obeyMuteSwitch = false
  }
  return audioCtx
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

async function playText(text, type, kind, failMsg) {
  if (config.USE_MOCK) {
    const src = mock.audioSrc(text, type, kind)
    if (src) playSrc(src, failMsg)
    return
  }
  let m
  try {
    m = await prepare(text, type, kind)
  } catch (e) {
    m = null
  }
  if (!m) return

  // 本地文件：零网络，秒播
  if (m.local) {
    playSrc(m.local, failMsg)
    return
  }
  if (!m.remote) return // 例句未预置音频：静默跳过
  playSrc(await toTempUrl(m.remote), failMsg)
}

/** 播放单词发音 */
function playWord(word, lang) {
  if (!word) return
  const type = langToType(lang)
  playText(String(word), type, 'word', '发音加载失败')
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
  playText(String(text), type, 'sentence', '例句发音加载失败')
}

/** 停止播放 */
function stop() {
  if (audioCtx) {
    audioCtx.stop()
    audioCtx.offEnded && audioCtx.offEnded()
    audioCtx.offError && audioCtx.offError()
  }
}

/* ================= 预加载 ================= */

function pump() {
  while (running < PRELOAD_CONCURRENCY && queue.length) {
    const job = queue.shift()
    const key = keyOf(job.text, job.type)
    const hit = memo[key]
    // 已就绪（本地已有 / 已知云端没有）就别再排队了
    if (hit && (hit.local || (!hit.remote && !hit.saving))) continue
    running++
    runJob(job)
  }
}

async function runJob(job) {
  try {
    const m = await prepare(job.text, job.type, job.kind)
    if (m && m.saving) await m.saving // 预加载的语义是「等它真的落到本地」
  } catch (e) {
    // 静默：预加载失败只是没省下时间，不是错误
  } finally {
    running--
    pump()
  }
}

/**
 * 内部：入队一批预加载任务。
 * @param {Array<{text:string,kind?:'word'|'sentence',lang?:string}>} items
 */
function enqueue(items) {
  if (config.USE_MOCK) return // mock 下音频是远端直链，预加载等于白白联网
  const list = (items || []).filter((x) => x && x.text).slice(0, PRELOAD_MAX_ITEMS)
  if (!list.length) return
  const seen = {}
  list.forEach((it) => {
    const text = String(it.text)
    const type = langToType(it.lang)
    const key = keyOf(text, type)
    if (seen[key]) return // 同一批里的重复文本（如选项恰好命中题干）只排一次
    seen[key] = true
    queue.push({ text, kind: it.kind === 'sentence' ? 'sentence' : 'word', type })
  })
  pump()
}

/** 预加载一批单词音频（不播放） */
function preloadWords(words, lang) {
  enqueue((words || []).map((w) => ({ text: w, kind: 'word', lang })))
}

/**
 * 预加载一批例句/整句音频（不播放）。
 * 未预置音频的句子会拿到 remote=null，之后播放静默跳过——与旧行为一致。
 */
function preloadSentences(texts, lang) {
  enqueue((texts || []).map((t) => ({ text: t, kind: 'sentence', lang })))
}

/**
 * 预热 audio_cache 云函数实例。
 *
 * 首次调用云函数要等冷启动（数百毫秒到秒级），这正是「第一次点喇叭要等一下」的大头。
 * 空 text 会被云函数立刻拒绝（missing text）—— 不写库、不外呼、不产生任何数据，
 * 但容器已经起来，后续真实调用直接命中热实例。
 */
function warmup() {
  if (warmedUp || config.USE_MOCK) return
  warmedUp = true
  try {
    wx.cloud.callFunction({
      name: config.FN.AUDIO_CACHE,
      data: { text: '', type: 2 },
      success: () => {},
      fail: () => {}
    })
  } catch (e) {
    // 预热失败无所谓
  }
}

module.exports = {
  playWord,
  playSentence,
  preloadWords,
  preloadSentences,
  warmup,
  stop,
  /** 仅测试用：把本地缓存上限改小，好让 LRU 淘汰这条极少走到的分支能被覆盖 */
  _setLocalMaxBytes: (n) => {
    localMaxBytes = n
  },
  /** 供调试/测试观测内部积压 */
  _pending: () => queue.length + running
}
