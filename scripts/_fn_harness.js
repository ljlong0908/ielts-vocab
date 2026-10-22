'use strict'
/**
 * 云函数单测的**共享骨架** —— test_finish_extra_round / test_start_extra_round 等
 * 云函数级测试的公共部分（内存假 DB + `wx-server-sdk` 桩）都收在这里。
 *
 * 为什么值得抽出来：两份桩原本逐行复制，改一处（比如补一个 command 操作）
 * 要改两遍，漏一处就变成「两个测试跑在不同的假 DB 上」，排查成本极高。
 *
 * 做法：把 `wx-server-sdk` 换成本文件里的内存假 DB，然后 **require 真实的
 *      cloudfunctions/<fn>/index.js** —— 测的是线上那份代码本身。
 *
 * ⚠️ 两条踩过的坑，改这里之前先读：
 *   ① 云函数**顶层**就执行了 `db.collection('words')`，所以假 DB 必须
 *      **每次查询时重读 store**，不能把数组缓存在查询对象里 ——
 *      否则换用例时句柄还攥着旧数组，用例之间互相污染。
 *   ② `store` 是**按引用**暴露的（`store()` 直接返回那个对象）。测试里
 *      `store.words = [...]`、`groupOf().stage === 'x'` 这类写法依赖引用，
 *      千万不要在这里做深拷贝。
 *
 * ⚠️ 只实现测试真正用到的子集（where/orderBy/limit/field/get/update、doc().update、add
 *    与 7 个 command 操作）。orderBy 的字符串字段按字典序排（日期串相减得 NaN，
 *    会把排序静默吞掉）；新测试还需要别的 command / 操作时在这里补齐 —— 补齐是共享收益。
 */
const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..')

/** 与云函数同语义的「今天」（东八区），offset 单位：天 */
const dateStr = (offset = 0) =>
  new Date(Date.now() + 28800000 + offset * 86400000).toISOString().slice(0, 10)

/* ---------------- 内存假 DB ---------------- */
let store = {}

const command = {
  in: (v) => ({ __op: 'in', v }),
  nin: (v) => ({ __op: 'nin', v }),
  neq: (v) => ({ __op: 'neq', v }),
  gt: (v) => ({ __op: 'gt', v }),
  lte: (v) => ({ __op: 'lte', v }),
  addToSet: (v) => ({ __op: 'addToSet', v }),
  inc: (v) => ({ __op: 'inc', v })
}

function matchOne(v, c) {
  if (!c || typeof c !== 'object' || !c.__op) return v === c
  if (c.__op === 'in') return c.v.indexOf(v) >= 0
  if (c.__op === 'nin') return c.v.indexOf(v) < 0
  if (c.__op === 'neq') return v !== c.v
  if (c.__op === 'gt') return v > c.v
  if (c.__op === 'lte') return v <= c.v
  return false
}

const matchDoc = (doc, cond) => Object.keys(cond).every((k) => matchOne(doc[k], cond[k]))

function makeQuery(name, cond) {
  let out = (store[name] || []).filter((d) => matchDoc(d, cond))
  // 排序子句：数字走差值，字符串（如 nextReviewDate 日期串）走字典序 ——
  // 日期字符串直接相减得 NaN，sort 拿到 NaN 等于不排序，会静默吞掉 orderBy 断言。
  const cmp = (a, b, field) => {
    const x = a[field]
    const y = b[field]
    if (typeof x === 'string' || typeof y === 'string') {
      return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0
    }
    return (x || 0) - (y || 0)
  }
  const q = {
    orderBy: (field, dir) => {
      out = out.slice().sort((a, b) => (dir === 'desc' ? -cmp(a, b, field) : cmp(a, b, field)))
      return q
    },
    limit: (n) => {
      out = out.slice(0, n)
      return q
    },
    field: () => q,
    get: async () => ({ data: out }),
    // 批量更新（dismiss_wrong 的打标就是 where().update()）；返回 stats.updated 供幂等断言
    update: async ({ data }) => {
      const rows = (store[name] || []).filter((d) => matchDoc(d, cond))
      rows.forEach((d) => Object.assign(d, data))
      return { stats: { updated: rows.length } }
    }
  }
  return q
}

/** 支持点路径写入：extraRounds.0.stage / extraRounds.0.finishedAt */
function applyUpdate(name, id, data) {
  const doc = (store[name] || []).filter((d) => d._id === id)[0]
  if (!doc) throw new Error('doc not found: ' + name + '/' + id)
  Object.keys(data).forEach((k) => {
    const parts = k.split('.')
    let cur = doc
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]]
    const leaf = parts[parts.length - 1]
    const v = data[k]
    // command 对象（_.addToSet / _.inc）要按语义落值 —— 早期直接赋整个命令对象，
    // 字段会变成 {__op:...}，读起来还是「写成功了」，属静默错误
    if (v && typeof v === 'object' && v.__op) {
      if (v.__op === 'addToSet') {
        const arr = Array.isArray(cur[leaf]) ? cur[leaf] : []
        if (arr.indexOf(v.v) < 0) arr.push(v.v)
        cur[leaf] = arr
      } else if (v.__op === 'inc') {
        cur[leaf] = (cur[leaf] || 0) + v.v
      } else {
        cur[leaf] = v.v
      }
    } else {
      cur[leaf] = v
    }
  })
}

const db = {
  collection: (name) => ({
    where: (cond) => makeQuery(name, cond),
    doc: (id) => ({ update: async ({ data }) => applyUpdate(name, id, data) }),
    add: async ({ data }) => {
      const rows = (store[name] = store[name] || [])
      const _id = data._id || name + '_' + (rows.length + 1)
      rows.push(Object.assign({ _id }, data))
      return { _id }
    }
  }),
  command
}

/**
 * 换一个假数据集（**按引用**传入，测试后续可直接改它）。
 * 建议在各测试里包一层 resetStore(opts)，把「本测试的场景」写在那层。
 */
const setStore = (next) => {
  store = next
}
const getStore = () => store

/**
 * 加载真实云函数。
 * @param {string} fnName  云函数目录名
 * @param {string} openid  假登录态
 * @returns {Function} main
 */
function loadFn(fnName, openid = 'o1') {
  const origLoad = Module._load
  Module._load = function (request) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'dyn-test',
        init() {},
        database: () => db,
        getWXContext: () => ({ OPENID: openid })
      }
    }
    return origLoad.apply(this, arguments)
  }
  return require(path.join(ROOT, 'cloudfunctions', fnName, 'index.js')).main
}

module.exports = { ROOT, dateStr, setStore, getStore, loadFn, db, command }
