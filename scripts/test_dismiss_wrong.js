/**
 * dismiss_wrong 云函数逻辑自测（node 直跑，零依赖、不连云）
 * 用法：node scripts/test_dismiss_wrong.js
 *
 * 为什么单测这个函数：错题本「已掌握」是用户自评出口，此前的语义只打在
 * `records` 上（错题本据此过滤）。R1（2026-10-13）补上**复习调度同步**：
 * `user_words` 不同步的话，用户点了「已掌握」，次日复习集合
 * （status='reviewing' 且 nextReviewDate≤今天）照考这个词 —— 两套系统不通。
 * R6（2026-10-13）之后，这里还是**出池词（'reviewed'）转正 mastered 的唯一入口**：
 * 复习答错的词次日不再自动复习，只有在错题本点「已掌握」才算真正掌握。
 * 本测试钉四件事：
 *   ① records 打标范围（该词所有答错记录；答对记录不动）
 *   ② R1：user_words 同步 mastered；记录不存在时**不建**（没打卡的词次日重学可自愈）
 *   ③ R6：'reviewed' 出池词经此处转正 mastered
 *   ④ 幂等（重复点无副作用）
 *
 * 共享骨架（内存假 DB + wx-server-sdk 桩）见 scripts/_fn_harness.js。
 */
const { setStore, getStore, loadFn } = require('./_fn_harness')
const { tester } = require('./_harness')

const main = loadFn('dismiss_wrong')

/* ---------------- 本用例的数据集 ---------------- */
function resetStore(opts = {}) {
  setStore({
    records: [
      { _id: 'rc1', _openid: 'o1', wordId: 'w1', isCorrect: false },
      { _id: 'rc2', _openid: 'o1', wordId: 'w1', isCorrect: false },
      { _id: 'rc3', _openid: 'o1', wordId: 'w1', isCorrect: true },
      { _id: 'rc4', _openid: 'o1', wordId: 'w2', isCorrect: false }
    ],
    user_words: opts.userWords || [
      { _id: 'uw1', _openid: 'o1', wordId: 'w1', status: 'reviewing', round: 2, wrongCount: 2, nextReviewDate: '2026-10-14' }
    ]
  })
}

const records = () => getStore().records
const userWords = () => getStore().user_words
const uwOf = (wordId) => getStore().user_words.filter((w) => w.wordId === wordId)[0]

const { t, done } = tester()

;(async () => {
  /* ===== 用例 1：records 打标范围 ===== */
  resetStore()
  const r1 = await main({ wordId: 'w1' })
  t('打标：code=0', r1.code === 0)
  t('打标：updated=2（该词两条答错记录）', r1.data.updated === 2)
  t('打标：两条答错记录都带 mastered=true', records()[0].mastered === true && records()[1].mastered === true)
  t('打标：答对记录不动（不是错题，不进错题本）', records()[2].mastered === undefined)
  t('打标：别的词的记录不动', records()[3].mastered === undefined)

  /* ===== 用例 2（R1）：user_words 同步 mastered，次日复习集合不再包含它 ===== */
  resetStore()
  const r2 = await main({ wordId: 'w1' })
  t('R1：scheduleSynced=true', r2.data.scheduleSynced === true)
  t('R1：user_words status=mastered', uwOf('w1').status === 'mastered')
  t('R1：nextReviewDate 清空（配合 status 双保险排除到期集合）', uwOf('w1').nextReviewDate === '')
  t('R1：wrongCount 等学习历史不清洗（正确率统计靠 records，本就在）', uwOf('w1').wrongCount === 2)

  /* ===== 用例 3（R1）：user_words 无该词记录 → 不建、不算失败 ===== */
  resetStore({ userWords: [] })
  const r3 = await main({ wordId: 'w1' })
  t('无 user_words 记录：scheduleSynced=false（不硬建半条记录）', r3.data.scheduleSynced === false)
  t('无 user_words 记录：records 打标照常', r3.code === 0 && records()[0].mastered === true)
  t('无 user_words 记录：user_words 仍为空（学了没打卡 → 次日重学自愈）', userWords().length === 0)

  /* ===== 用例 4：幂等 —— 重复点无副作用 ===== */
  resetStore()
  await main({ wordId: 'w1' })
  const r4 = await main({ wordId: 'w1' })
  t('幂等：重复调用 code=0', r4.code === 0)
  t('幂等：updated 仍为 2（重写同一个值）', r4.data.updated === 2)
  t('幂等：user_words 仍是 mastered（不会抖动成别的状态）', uwOf('w1').status === 'mastered')

  /* ===== 用例 5：缺 wordId → 拒绝 ===== */
  resetStore()
  const r5 = await main({})
  t('缺 wordId：code=1', r5.code === 1)
  t('缺 wordId：不动任何数据', records()[0].mastered === undefined && uwOf('w1').status === 'reviewing')

  /* ===== 用例 6（R6）：出池词（reviewed）经错题本转正 mastered ===== */
  resetStore({
    userWords: [
      { _id: 'uw6', _openid: 'o1', wordId: 'w1', status: 'reviewed', wrongCount: 1, nextReviewDate: '' }
    ]
  })
  const r6 = await main({ wordId: 'w1' })
  t('R6：scheduleSynced=true', r6.data.scheduleSynced === true)
  t('R6：reviewed → mastered（出池词转正的唯一入口）', uwOf('w1').status === 'mastered')
  t('R6：nextReviewDate 仍是空（终态之间不抖动）', uwOf('w1').nextReviewDate === '')

  done()
})()
