#!/usr/bin/env node
/**
 * test_audio.js —— audio.js 的无头回归（零依赖，node 直跑）
 *
 * 重点守护「cloud:// → https 临时链接」这一步（真机截断坑）：
 *   ① cloud:// fileID 必须经 getTempFileURL 转换后才进 ctx.src
 *   ② https（dictvoice）/ mock 路径原样透传，不白打一次转换请求
 *   ③ 转换结果内存缓存（同 fileID 第二次不再调 getTempFileURL）
 *   ④ 转换失败降级回 fileID（宁可冒截断风险也不哑掉）
 *   ⑤ playSentence 拿到 null（例句未预置）仍然静默
 *   ⑥ playSrc 播放前先 stop（防叠音）
 *
 * 用法：node scripts/test_audio.js   （全绿退出码 0）
 */
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const drain = () => new Promise((r) => setTimeout(r, 0))

let pass = 0, fail = 0
function t(desc, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}`)
  ok ? pass++ : fail++
}

/* ---------- wx / config / mock 桩 ---------- */
const AUDIO = require.resolve(path.join(ROOT, 'miniprogram/utils/audio.js'))
const CFG = require.resolve(path.join(ROOT, 'miniprogram/config.js'))
const MOCK = require.resolve(path.join(ROOT, 'miniprogram/utils/mock.js'))

const played = []
let tempCalls = 0
let tempOk = true // false 时模拟 getTempFileURL 失败
const ctx = {
  src: '',
  stop() { played.push('stop') },
  play() { played.push('play:' + this.src) },
  onError() {}, offEnded() {}, offError() {}
}
const storages = {}
global.wx = {
  createInnerAudioContext: () => ctx,
  getStorage: ({ key, success, fail }) =>
    storages[key] !== undefined ? success({ data: storages[key] }) : fail(),
  setStorage: ({ key, data }) => { storages[key] = data },
  showToast: () => {},
  cloud: {
    callFunction: ({ success }) =>
      success({ result: { code: 0, data: { fileID: 'cloud://env/audio/s_quote.mp3' } } }),
    getTempFileURL: ({ fileList, success }) => {
      tempCalls++
      if (tempOk) {
        success({ fileList: [{ fileID: fileList[0], tempFileURL: 'https://tmp.example/' + fileList[0].split('/').pop() }] })
      } else {
        success({ fileList: [{ fileID: fileList[0] }] }) // 无 tempFileURL = 转换失败
      }
    }
  }
}
require.cache[CFG] = { id: CFG, filename: CFG, loaded: true, exports: { USE_MOCK: false, TTS_LANG: 'en_US', FN: { AUDIO_CACHE: 'audio_cache' } } }
require.cache[MOCK] = { id: MOCK, filename: MOCK, loaded: true, exports: { audioSrc: () => null } }

const audio = require(AUDIO)

/* ---------- ① 例句：cloud:// 必须转换后才播 ---------- */
;(async () => {
  played.length = 0; tempCalls = 0; tempOk = true
  await audio.playSentence('A different language is a different vision of life.')
  await drain()
  const plays = played.filter((x) => x.startsWith('play:'))
  t('例句：恰好播放一次', plays.length === 1)
  t('例句：ctx.src 是 https 临时链接（不是 cloud://）', /^play:https:\/\//.test(plays[0] || ''))
  t('例句：getTempFileURL 被调用 1 次', tempCalls === 1)

  /* ---------- ③ 同一句再播：走内存缓存，不再打转换请求 ---------- */
  played.length = 0
  await audio.playSentence('A different language is a different vision of life.')
  await drain()
  const plays2 = played.filter((x) => x.startsWith('play:'))
  t('第二遍：仍正常播放', plays2.length === 1 && /^play:https:\/\//.test(plays2[0] || ''))
  t('第二遍：getTempFileURL 未再调用（内存缓存生效）', tempCalls === 1)
  t('第二遍：播放前先 stop（防叠音）', played[0] === 'stop')

  /* ---------- ② https（dictvoice）原样透传 ---------- */
  // 单词走 word kind：桩里 cloud.callFunction 也会返回 cloud://，需让它失败才落 dictvoice。
  // 直接验证更底层的行为：换一个「云端失败」桩。
  require.cache[AUDIO] = undefined
  delete require.cache[AUDIO]
  global.wx.cloud.callFunction = ({ fail }) => fail(new Error('down'))
  const audio2 = require(AUDIO)
  played.length = 0
  await audio2.playWord('zzz_unknown_word')
  await drain()
  const plays3 = played.filter((x) => x.startsWith('play:'))
  t('单词：云端失败降级 dictvoice，https 原样透传（0 次转换）',
    /^play:https:\/\/dict\.youdao\.com/.test(plays3[0] || '') && tempCalls === 1)

  /* ---------- ④ 转换失败 → 降级回 fileID（不哑掉） ---------- */
  const audio3 = (() => {
    require.cache[AUDIO] = undefined
    delete require.cache[AUDIO]
    global.wx.cloud.callFunction = ({ success }) =>
      success({ result: { code: 0, data: { fileID: 'cloud://env/audio/s_x.mp3' } } })
    tempOk = false
    return require(AUDIO)
  })()
  played.length = 0
  await audio3.playSentence('Some other quote text.')
  await drain()
  const plays4 = played.filter((x) => x.startsWith('play:'))
  t('转换失败：退回 cloud:// fileID 继续播（不静默）', /^play:cloud:\/\//.test(plays4[0] || ''))

  /* ---------- ⑤ 例句未预置（null）仍静默 ---------- */
  const audio4 = (() => {
    require.cache[AUDIO] = undefined
    delete require.cache[AUDIO]
    require.cache[MOCK] = { id: MOCK, filename: MOCK, loaded: true, exports: { audioSrc: () => null } }
    global.wx.cloud.callFunction = ({ success }) => success({ result: { code: 0, data: null } })
    return require(AUDIO)
  })()
  played.length = 0
  await audio4.playSentence('Not preseeded quote.')
  await drain()
  t('未预置例句：静默不播（行为不变）', played.filter((x) => x.startsWith('play:')).length === 0)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
