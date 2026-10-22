/**
 * build_questions —— 生成练习题（双向题型 1:1 混合）
 *
 * 题型：cn_option 中选项（题干英文 → 选项中文）
 *       en_option 英选中（题干中文 → 选项英文）
 *
 * 说明：题目连同 answerIndex 一起保存在 daily_plans 服务端字段中，并**原样下发**。
 *       前端据此在本地同步判对错（点下去立即出结果，不等云函数往返）；
 *       submit_answer 退化为「后台落库」——records / user_words / plan.stage 仍由它写。
 *       代价：答案对客户端逆向者可读（词汇练习类产品作弊动机极低，换零判题延迟值得）。
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const plans = db.collection('daily_plans')
const words = db.collection('words')

// 东八区「今天」：先 +8h 再取 UTC 日期；offset 单位＝天
const dateStr = (offset = 0) =>
  new Date(Date.now() + 28800000 + offset * 86400000).toISOString().slice(0, 10)

function shuffle(arr) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function sample(arr, n) {
  return shuffle(arr).slice(0, n)
}

function buildQuestion(w, type, pool, idx) {
  const isCn = type === 'cn_option'
  const correctText = isCn ? w.meaning : w.word
  const candidates = pool.filter((p) => {
    const t = isCn ? p.meaning : p.word
    return t && t !== correctText
  })
  const distractors = sample(candidates, 3).map((p) => (isCn ? p.meaning : p.word))
  const options = shuffle([correctText].concat(distractors))
  return {
    id: `${w._id}_${idx}`,
    wordId: w._id,
    type,
    stem: isCn ? w.word : w.meaning,
    phonetic: isCn ? w.phoneticUS || w.phoneticUK || '' : '',
    // 词根拆解（D15）：练习页题干区在单词下方展示，做题时给构词线索。
    // words.roots 是 enrich 产物（[{part,type,meaning}]），未 enrich 的词没有 → 兜底空数组。
    roots: w.roots || [],
    options,
    answerIndex: options.indexOf(correctText),
    passed: false,
    wrong: false
  }
}

/**
 * 下发形状（= 前端 practice.js 的契约）。
 *   answerIndex —— 本地判题用：前端 `choice === answerIndex` 即可判对错，不必再等一次云函数
 *   audioText   —— 答对后要读的英文：cn_option 是题干（英文词），en_option 是正确选项
 *                  ⚠️ 判据必须用 type，不能用 `phonetic` 是否为空来推 ——
 *                     没音标的 cn_option 会被推成中文选项，前端拿去查音频必然落空
 *   roots       —— 词根拆解，仅 cn_option 题干区展示。旧题（D15 之前生成的队列）没有该
 *                 字段，兜底 [] → 前端不渲染词根区（可选内容，不是核心 UI，允许缺失）
 */
function toClient(queue) {
  return queue.map((q) => ({
    id: q.id,
    wordId: q.wordId,
    type: q.type,
    stem: q.stem,
    phonetic: q.phonetic,
    roots: Array.isArray(q.roots) ? q.roots : [],
    options: q.options,
    answerIndex: q.answerIndex,
    audioText: q.type === 'cn_option' ? q.stem : q.options[q.answerIndex] || ''
  }))
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const { phase = 'practice', round = 0 } = event
  const r = Number(round) || 0
  const today = dateStr(0)

  try {
    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0]
    if (!plan) return { code: -1, message: '请先初始化当日计划' }

    // 队列路由（C4）：round>0 → 加练组内队列；round===0 → 主流程队列（现有行为不变）。
    // 若不加 round 隔离，加练会直接覆盖 plan.practiceQueue，主流程被静默破坏。
    let queuePath
    let existing
    let wordIds
    if (r > 0) {
      const groups = Array.isArray(plan.extraRounds) ? plan.extraRounds : []
      const gi = groups.findIndex((g) => g.roundId === r)
      if (gi < 0) return { code: -1, message: '加练组不存在' }
      queuePath = `extraRounds.${gi}.practiceQueue`
      existing = groups[gi].practiceQueue
      wordIds = groups[gi].wordIds || []
    } else {
      queuePath = phase === 'review' ? 'reviewQueue' : 'practiceQueue'
      existing = plan[queuePath]
      wordIds = phase === 'review' ? plan.reviewWordIds || [] : plan.newWordIds || []
    }

    if (Array.isArray(existing) && existing.length) {
      return { code: 0, data: { questions: toClient(existing), reused: true } }
    }

    if (!wordIds.length) return { code: 0, data: { questions: [], reused: false } }

    const target = (await words.where({ _id: _.in(wordIds) }).get()).data
    if (!target.length) return { code: 0, data: { questions: [], reused: false } }

    let pool = (await words.where({ _id: _.nin(wordIds) }).limit(300).get()).data
    if (pool.length < 3) pool = (await words.limit(300).get()).data

    const queue = target.map((w, i) =>
      buildQuestion(w, i % 2 === 0 ? 'cn_option' : 'en_option', pool, i)
    )
    const mixed = shuffle(queue)

    await plans.doc(plan._id).update({ data: { [queuePath]: mixed, updatedAt: new Date() } })

    return { code: 0, data: { questions: toClient(mixed), reused: false } }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'BUILD_QUESTIONS_FAILED' }
  }
}
