/**
 * submit_answer —— 服务端判题 + 记录 + 复习状态推进
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const plans = db.collection('daily_plans')
const words = db.collection('words')
const records = db.collection('records')
const userWords = db.collection('user_words')

function dateStr(offset = 0) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const { phase = 'practice', questionIndex, choice } = event
  const today = dateStr(0)

  try {
    const planRes = await plans.where({ _openid: OPENID, date: today }).get()
    const plan = planRes.data[0]
    if (!plan) return { code: -1, message: '请先初始化当日计划' }

    const key = phase === 'review' ? 'reviewQueue' : 'practiceQueue'
    const queue = Array.isArray(plan[key]) ? plan[key] : []
    const q = queue[questionIndex]
    if (!q) return { code: -1, message: '题目不存在' }

    const correct = Number(choice) === q.answerIndex

    let word = {}
    try {
      word = (await words.doc(q.wordId).get()).data || {}
    } catch (e) {
      word = {}
    }

    await records.add({
      data: {
        _openid: OPENID,
        wordId: q.wordId,
        date: today,
        phase: phase === 'review' ? 'review' : 'practice',
        questionType: q.type,
        isCorrect: correct,
        choice: Number(choice),
        createdAt: new Date()
      }
    })

    const uwRes = await userWords.where({ _openid: OPENID, wordId: q.wordId }).get()
    const uw = uwRes.data[0]

    if (correct) {
      q.passed = true
      if (phase === 'review' && uw) {
        // 一轮内一次答对且历史无错 → 掌握；否则留存次日再复习
        const clean = !q.wrong && (uw.wrongCount || 0) === 0
        await userWords.doc(uw._id).update({
          data: {
            status: clean ? 'mastered' : 'reviewing',
            round: (uw.round || 1) + 1,
            lastReviewDate: today,
            nextReviewDate: clean ? '' : dateStr(1),
            updatedAt: new Date()
          }
        })
      }
    } else {
      q.wrong = true
      if (uw) {
        await userWords.doc(uw._id).update({
          data: {
            wrongCount: (uw.wrongCount || 0) + 1,
            status: 'reviewing',
            nextReviewDate: dateStr(1),
            updatedAt: new Date()
          }
        })
      }
    }

    const allPassed = queue.every((x) => x.passed)
    const patch = { [key]: queue, updatedAt: new Date() }
    if (allPassed && phase === 'review') patch.stage = 'learning'
    if (allPassed && phase === 'practice') patch.stage = 'practice_done'
    await plans.doc(plan._id).update({ data: patch })

    return {
      code: 0,
      data: {
        correct,
        answerIndex: q.answerIndex,
        wordId: q.wordId,
        word: word.word || '',
        meaning: word.meaning || '',
        phaseDone: allPassed
      }
    }
  } catch (e) {
    return { code: -1, message: (e && e.message) || 'SUBMIT_ANSWER_FAILED' }
  }
}
