#!/usr/bin/env node
/**
 * test_audio.js —— audio.js 的无头回归（零依赖，node 直跑）
 *
 * 这一版的重点从「cloud:// → https 临时链接」整体前移到**本地缓存 + 预加载**，
 * 因为发声延迟的大头就落在这两块上。守住的行为：
 *
 *   首播      走远端先出声（不等落盘），后台把音频写进 USER_DATA_PATH
 *   再播      直接吃本地文件：不再调云函数、不再换临时链接、零网络
 *   重启      仅凭 storage 里的记录 + 本地文件即可恢复，不需要重新联网
 *   文件被回收 记录还在但文件没了 → 回退远端重下，不哑掉
 *   预加载    只落盘不发声；预载过的文本播放时零网络
 *   队列      并发封顶 3、同一文本不重复请求
 *   淘汰      本地超上限按 LRU 删最旧的，并清掉记录里的 local 指针
 *   降级      云端失败单词走 dictvoice；例句未预置静默；临时链接转换失败退回 fileID
 *
 * 用法：node scripts/test_audio.js   （全绿退出码 0）
 */
const path = require('path')
/** 共享骨架（ROOT / drain / 断言计数）见 scripts/_harness.js */
const { ROOT, drain, tester } = require('./_harness')

const { t, done } = tester()

/* ---------- 被测模块与依赖的桩 ---------- */
const AUDIO = require.resolve(path.join(ROOT, 'miniprogram/utils/audio.js'))
const CFG = require.resolve(path.join(ROOT, 'miniprogram/config.js'))
const MOCK = require.resolve(path.join(ROOT, 'miniprogram/utils/mock.js'))

const USER = '/usr'
const INDEX_KEY = 'audio_local_index_v1'

/* ---------- 假世界（跨 freshAudio 保留，用来模拟「杀进程重进」） ---------- */
/** 假磁盘：集合里有 = 文件存在 */
const DISK = new Set()
/** 假磁盘上每个文件的大小 */
const SIZES = {}
const storages = {}

/* ---------- 探针 ---------- */
const played = []
let tempCalls = 0 // getTempFileURL 次数
let cloudCalls = 0 // callFunction 次数
let dictCalls = 0 // downloadFile(https) 次数 —— 即「dictvoice 兜底」
let downloadCalls = 0 // cloud.downloadFile 次数
let saveCalls = 0 // 落盘次数
let accessCalls = 0 // 本地文件存在性检查次数（性能护栏用）
let active = 0
let maxActive = 0
let tempOk = true // false 时模拟 getTempFileURL 转换失败
let useMock = false
/** 云端行为：'hit' 返回 fileID | 'miss' 返回 code:-1 | 'fail' 直接失败 */
let cloudMode = 'hit'

const FILE_ID = 'cloud://env/audio/s_quote.mp3'

function resetWorld() {
  DISK.clear()
  Object.keys(SIZES).forEach((k) => delete SIZES[k])
  Object.keys(storages).forEach((k) => delete storages[k])
  played.length = 0
  tempCalls = cloudCalls = dictCalls = downloadCalls = saveCalls = accessCalls = 0
  active = 0
  maxActive = 0
  tempOk = true
  useMock = false
  cloudMode = 'hit'
}

/** 假文件系统：只需够 audio.js 用（存在性判断 / 落盘 / 大小 / 删除） */
const FS = {
  mkdirSync() {},
  accessSync(p) {
    accessCalls++
    if (!DISK.has(p)) throw new Error('ENOENT: ' + p)
  },
  unlinkSync(p) {
    if (!DISK.has(p)) throw new Error('ENOENT: ' + p)
    DISK.delete(p)
  },
  statSync(p) {
    if (!DISK.has(p)) throw new Error('ENOENT: ' + p)
    return { size: SIZES[p] || 0 }
  },
  saveFile({ tempFilePath, filePath, success, fail }) {
    saveCalls++
    if (!filePath) return fail && fail(new Error('bad filePath'))
    DISK.add(filePath)
    SIZES[filePath] = SIZES[tempFilePath] || 40
    success({ savedFilePath: filePath })
  },
  copyFile({ srcPath, destPath, success }) {
    DISK.add(destPath)
    SIZES[destPath] = SIZES[srcPath] || 40
    success({})
  }
}

const ctx = {
  src: '',
  stop() {
    played.push('stop')
  },
  play() {
    played.push('play:' + this.src)
  },
  onError() {},
  offEnded() {},
  offError() {}
}

function installWx() {
  global.wx = {
    env: { USER_DATA_PATH: USER },
    getFileSystemManager: () => FS,
    createInnerAudioContext: () => ctx,
    showToast() {},
    getStorage: ({ key, success, fail }) =>
      storages[key] !== undefined ? success({ data: storages[key] }) : fail && fail(),
    setStorage: ({ key, data }) => {
      storages[key] = data
    },
    getStorageSync: (k) => storages[k],
    setStorageSync: (k, v) => {
      storages[k] = v
    },
    downloadFile: ({ url, success }) => {
      dictCalls++
      // ⚠️ 必须异步回包：真实下载要过一个网络往返，正是「首播先用远端流、
      //    落盘在后台」这个设计成立的前提。桩里同步回包会让 m.local 在
      //    播放分支之前就绪，测出来的行为与真机不一致（这个坑已踩过一次）。
      setTimeout(() => success({ statusCode: 200, tempFilePath: '/tmp/dict.mp3' }), 0)
    },
    cloud: {
      callFunction: ({ success, fail }) => {
        cloudCalls++
        if (cloudMode === 'fail') return fail && fail(new Error('down'))
        if (cloudMode === 'miss') return success({ result: { code: -1, message: 'no' } })
        success({ result: { code: 0, data: { fileID: FILE_ID } } })
      },
      getTempFileURL: ({ fileList, success }) => {
        tempCalls++
        if (tempOk) {
          success({ fileList: [{ fileID: fileList[0], tempFileURL: 'https://tmp.example/' + fileList[0].split('/').pop() }] })
        } else {
          success({ fileList: [{ fileID: fileList[0] }] }) // 无 tempFileURL = 转换失败
        }
      },
      downloadFile: ({ fileID, success }) => {
        downloadCalls++
        active++
        if (active > maxActive) maxActive = active
        setTimeout(() => {
          active--
          success({ tempFilePath: '/tmp/' + fileID.split('/').pop() })
        }, 0)
      }
    }
  }
}

/** 重新 require audio.js = 模拟「杀进程重进」；假磁盘与 storage 保留 */
function freshAudio() {
  delete require.cache[AUDIO]
  require.cache[CFG] = {
    id: CFG,
    filename: CFG,
    loaded: true,
    exports: { USE_MOCK: useMock, TTS_LANG: 'en_US', FN: { AUDIO_CACHE: 'audio_cache' } }
  }
  require.cache[MOCK] = {
    id: MOCK,
    filename: MOCK,
    loaded: true,
    exports: { audioSrc: () => 'https://dict.youdao.com/dictvoice?audio=mock&type=2' }
  }
  return require(AUDIO)
}

/** 多等几轮事件循环：下载与落盘都是链式微任务 + setTimeout(0) */
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await drain()
}

const plays = () => played.filter((x) => x.startsWith('play:'))
const recOf = (text, type = 2) => storages['audio_cache_' + type + '_' + text]

;(async () => {
  installWx()

  /* ============ A. 首播走远端、后台落盘、再播吃本地 ============ */
  resetWorld()
  let audio = freshAudio()
  await audio.playWord('abandon')
  await drain()
  t('A1 首播：立即出声，不等落盘', plays().length === 1)
  t('A2 首播：走 https 临时链接（cloud:// 必须转换）', /^play:https:\/\//.test(plays()[0] || ''))
  t('A3 首播：已调过 audio_cache 云函数', cloudCalls === 1)

  await flush()
  const localPath = [...DISK][0] || ''
  t('A4 后台落盘：文件写进 USER_DATA_PATH 的 audio 目录', DISK.size === 1 && localPath.startsWith(USER + '/audio/'))
  t('A5 后台落盘：文件名只用短哈希，不含原始文本（避免非法字符）', /\/\d+_[a-z0-9-]+\.mp3$/.test(localPath))
  t('A6 后台落盘：storage 记录里存下了本地路径与大小', !!recOf('abandon') && recOf('abandon').local === localPath && recOf('abandon').size > 0)
  t('A7 后台落盘：仍保留 fileID（本地文件被回收后还能回退）', /^cloud:\/\//.test(recOf('abandon').fileID || ''))
  t('A8 落盘只走 cloud.downloadFile（不额外换临时链接）', downloadCalls === 1 && tempCalls === 1)

  played.length = 0
  await audio.playWord('abandon')
  await drain()
  t('A9 第二次播放：直接用本地文件（秒播，零网络）', plays()[0] === 'play:' + localPath)
  t('A10 第二次播放：未再调云函数 / 未再换临时链接', cloudCalls === 1 && tempCalls === 1)
  t('A11 播放前先 stop（防叠音）', played[0] === 'stop')

  /* ============ B. 重启后仅凭 storage + 本地文件恢复 ============ */
  audio = freshAudio()
  played.length = 0
  await audio.playWord('abandon')
  await drain()
  t('B1 重启后：仍走本地文件（跨启动生效）', plays()[0] === 'play:' + localPath)
  t('B2 重启后：零网络', cloudCalls === 1 && tempCalls === 1 && downloadCalls === 1)

  /* ============ C. 本地文件被系统回收 → 回退远端重下 ============ */
  DISK.clear() // 只清文件，留着 storage 记录（模拟系统回收 / 用户清缓存）
  audio = freshAudio()
  played.length = 0
  await audio.playWord('abandon')
  await drain()
  t('C1 文件不在：不哑掉，回退远端链接照常出声', /^play:https:\/\//.test(plays()[0] || ''))
  t('C2 文件不在：直接用记录里的 fileID，不重复调云函数', cloudCalls === 1)
  await flush()
  t('C3 文件不在：顺手重新落盘（下次又秒播）', DISK.size === 1)

  /* ============ D. 预加载：只落盘、不发声 ============ */
  resetWorld()
  audio = freshAudio()
  audio.preloadWords(['alpha', 'beta'])
  await flush()
  t('D1 预加载：不发声（静默落盘）', plays().length === 0)
  t('D2 预加载：两段都落到本地', DISK.size === 2)
  t('D3 预加载：未调用临时链接转换（本地化不需要它）', tempCalls === 0)

  played.length = 0
  await audio.playWord('alpha')
  await drain()
  t('D4 预载过的词播放：零网络、直接本地', /^play:\/usr\/audio\//.test(plays()[0] || '') && cloudCalls === 2 && tempCalls === 0)
  t('D5 预载过的词播放：也不再落盘一次（saveCalls 不涨）', saveCalls === 2)

  /* ============ E. 队列：并发封顶 + 同一文本去重 ============ */
  resetWorld()
  audio = freshAudio()
  audio.preloadWords(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'])
  audio.preloadWords(['w1', 'w2']) // 重复入队
  await flush(24)
  t('E1 并发封顶 3 路', maxActive === 3 && maxActive <= 3)
  t('E2 同一文本不重复请求云端', cloudCalls === 6)
  t('E3 六段全部落盘', DISK.size === 6)
  t('E4 队列排空', audio._pending() === 0)

  /* ============ F. 例句未预置：静默、不落盘、不兜底 ============ */
  resetWorld()
  cloudMode = 'miss' // 例句在 audio_cache 里查不到（未预置）
  audio = freshAudio()
  await audio.playSentence('Not preseeded quote.')
  await flush()
  t('F1 未预置例句：静默不播（行为不变）', plays().length === 0)
  t('F2 未预置例句：不落盘', DISK.size === 0)
  t('F3 未预置例句：不走 dictvoice 兜底（整句必失败）', dictCalls === 0)

  audio.preloadSentences(['Not preseeded quote.'])
  await flush()
  t('F4 未预置例句的预加载：同样静默、不落盘', plays().length === 0 && DISK.size === 0)

  /* ============ G. 单词云端失败 → dictvoice 兜底，且兜底音频也落盘 ============ */
  resetWorld()
  cloudMode = 'fail'
  audio = freshAudio()
  await audio.playWord('zzz_unknown')
  await drain()
  t('G1 云端失败：降级 dictvoice 出声', /^play:https:\/\/dict\.youdao\.com/.test(plays()[0] || ''))
  await flush()
  t('G2 兜底音频同样落盘（这个词下次也秒播）', DISK.size === 1 && dictCalls === 1)
  t('G3 兜底记录的 remote 存成 url（不是 fileID）', recOf('zzz_unknown').local && !recOf('zzz_unknown').fileID)

  played.length = 0
  audio = freshAudio()
  await audio.playWord('zzz_unknown')
  await drain()
  t('G4 重启后：兜底音频也走本地，不再打 youdao', plays()[0] === 'play:' + [...DISK][0] && dictCalls === 1)

  /* ============ H. 临时链接转换失败 → 退回 fileID（旧坑，不得回归） ============ */
  resetWorld()
  tempOk = false
  audio = freshAudio()
  await audio.playSentence('Some quote text.')
  await flush()
  t('H1 转换失败：退回 cloud:// fileID 继续播（不静默）', /^play:cloud:\/\//.test(plays()[0] || ''))
  t('H2 转换失败后仍会尝试落盘', DISK.size === 1)

  /* ============ I. LRU 淘汰 ============ */
  resetWorld()
  audio = freshAudio()
  audio._setLocalMaxBytes(120) // 每个文件 40 字节 → 上限只够放 3 个
  audio.preloadWords(['a1', 'a2', 'a3', 'a4'])
  await flush(24)
  t('I1 超上限：回收到水位（120 的 80% = 96 → 只留 2 个）', DISK.size === 2)
  t('I2 淘汰按 LRU：留下的最新两个', !recOf('a1').local && !recOf('a2').local && !!recOf('a3').local && !!recOf('a4').local)
  played.length = 0
  const dlBefore = downloadCalls
  const cloudBefore = cloudCalls
  await audio.playWord('a1')
  await flush()
  t('I3 被淘汰的词重播：出声（不哑掉）', plays().length === 1)
  t('I4 被淘汰的词重播：重新下载并落盘（记录里的 fileID 还在，故不必再问云函数）',
    downloadCalls > dlBefore && cloudCalls === cloudBefore && DISK.size === 3)

  /* ============ L. 冷启不逐个校验索引（性能护栏） ============ */
  // 索引攒到几百条时，若在首次使用时同步 accessSync 全扫一遍，
  // 第一次点喇叭会被白白卡住上百毫秒 —— 正是本次要消灭的等待。
  // 这条断言把「扫描次数与索引长度无关」钉死：改回扫描必然变红。
  resetWorld()
  audio = freshAudio()
  audio.preloadWords(['keep'])
  await flush()
  const realIdx = storages[INDEX_KEY] || []
  const ghosts = []
  for (let i = 0; i < 30; i++) {
    ghosts.push({ p: '/usr/audio/ghost' + i + '.mp3', k: '2_ghost' + i, s: 1024, t: Date.now() - 5000 })
  }
  storages[INDEX_KEY] = realIdx.concat(ghosts) // 索引里有 30 条指不到文件的脏行

  audio = freshAudio() // 冷启：内存清空，只留 storage + 假磁盘
  accessCalls = 0
  played.length = 0
  await audio.playWord('keep')
  await drain()
  t('L1 冷启不逐个校验索引：存在性检查次数与索引长度无关', accessCalls <= 3 && accessCalls < ghosts.length)
  t('L2 脏行不影响真缓存命中（仍走本地，零网络）', /^play:\/usr\/audio\//.test(plays()[0] || ''))

  /* ============ J. mock 模式：预加载不联网 ============ */
  resetWorld()
  useMock = true
  audio = freshAudio()
  audio.preloadWords(['m1', 'm2'])
  audio.preloadSentences(['mock sentence'])
  await flush()
  t('J1 USE_MOCK：预加载完全不联网', cloudCalls === 0 && downloadCalls === 0 && dictCalls === 0)
  t('J2 USE_MOCK：也不落盘', DISK.size === 0)

  /* ============ K. 云函数预热 ============ */
  resetWorld()
  audio = freshAudio()
  audio.warmup()
  audio.warmup() // 重复调用只应该打一次
  await drain()
  t('K1 预热：恰好一次空调用（叫醒实例即可）', cloudCalls === 1)
  t('K2 预热：不落盘、不发声', DISK.size === 0 && plays().length === 0)

  resetWorld()
  useMock = true
  audio = freshAudio()
  audio.warmup()
  await drain()
  t('K3 USE_MOCK：预热不联网', cloudCalls === 0)

  done()
})()
