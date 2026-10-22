/**
 * Mock 数据层 —— UX 原型调 UI 用
 *
 * 配合 config.USE_MOCK：
 *   USE_MOCK=true 时，utils/api.js 的 call() 与 utils/audio.js 的 resolveSrc()
 *   会走本文件，完全不联网（不调云函数、不读云存储）。
 *
 * 设计原则：
 *   1. 数据要能驱动所有 UI 状态——含边界态（暂缺 / 生成中 / 空 / 已完成）
 *   2. 接口响应结构与云函数保持一致：{ code: 0, data, message }
 *   3. handle(name, data) 返回 null 表示「未命中 mock」，会继续走真实调用
 *      （方便只 mock 部分接口，例如真实登录 + mock 内容）
 *
 * 场景切换：改 config.MOCK_SCENE
 *   'progress' —— 学习中（默认，覆盖面最广，6 张卡含暂缺/生成中边界态）
 *   'done'     —— 今日已完成
 *   'empty'    —— 词库已学完
 *
 * ⚠️ 题目**带着答案**下发（与云函数 build_questions 一致）：前端本地同步判对错，
 *    submitAnswer 退化为后台落库。mock 必须跟着下发 answerIndex，
 *    否则 USE_MOCK 下调 UI 会走「降级路径」，与真机行为分叉。
 */

const config = require('../config')

// 模拟网络延迟（ms）：调 UI 时太长会烦，太短看不到 loading 态
const DELAY = 120

const SCENE = config.MOCK_SCENE || 'progress'

/* ------------------------------------------------------------------ */
/* 词表：6 个词，覆盖完整 / 暂缺 / 生成中三种卡片状态                    */
/* ------------------------------------------------------------------ */

const WORDS = [
  {
    _id: 'w1',
    word: 'abandon',
    phoneticUS: '/əˈbændən/',
    phoneticUK: '/əˈbændən/',
    pos: 'v.',
    meaning: '放弃；抛弃',
    example: { en: 'They had to abandon the car in the snow.', cn: '他们不得不把车丢在雪地里。' },
    roots: [
      { part: 'ab-', type: '前缀', meaning: '离开' },
      { part: 'bandon', type: '词根', meaning: '控制；命令' }
    ],
    etymology: '源自古法语 abandoner，由 a-（去）+ bandon（控制权）构成，字面义为"交出控制权"，引申为放弃。',
    // 形似词（D12）：2 条 —— 覆盖「非满 3」态
    similar: [
      { word: 'abandonment', phonetic: '/əˈbændənmənt/', meaning: 'n. 抛弃；放任' },
      { word: 'abandoned', phonetic: '/əˈbændənd/', meaning: 'adj. 被抛弃的；恣意放任的' }
    ],
    enriched: true,
    enrichStatus: 'done'
  },
  {
    _id: 'w2',
    word: 'abstract',
    phoneticUS: '/ˈæbstrækt/',
    phoneticUK: '/ˈæbstrækt/',
    pos: 'adj.',
    meaning: '抽象的；摘要',
    example: { en: 'Beauty is an abstract concept.', cn: '美是一个抽象的概念。' },
    roots: [
      { part: 'abs-', type: '前缀', meaning: '脱离' },
      { part: 'tract', type: '词根', meaning: '拉；抽' }
    ],
    etymology: '源自拉丁语 abstractus，abs-（脱离）+ trahere（拉），本义为"从中抽出"，引申为抽象。',
    // 形似词：3 条拿满（abstract / attract / distract / subtract 是经典混对）
    similar: [
      { word: 'attract', phonetic: '/əˈtrækt/', meaning: 'vt. 吸引；引起' },
      { word: 'distract', phonetic: '/dɪˈstrækt/', meaning: 'vt. 转移；分心' },
      { word: 'subtract', phonetic: '/səbˈtrækt/', meaning: 'vt. 减去；扣掉' }
    ],
    enriched: true,
    enrichStatus: 'done'
  },
  {
    _id: 'w3',
    word: 'academic',
    phoneticUS: '/ˌækəˈdemɪk/',
    phoneticUK: '/ˌækəˈdemɪk/',
    pos: 'adj.',
    meaning: '学术的；学院的',
    example: { en: 'The academic year starts in September.', cn: '学年从九月开始。' },
    roots: [
      { part: 'academ-', type: '词根', meaning: '学院（源自 Akademos 园）' },
      { part: '-ic', type: '后缀', meaning: '…的' }
    ],
    etymology: '源自古希腊 Akademos 园，柏拉图在此讲学，后泛指学术机构与学术研究。',
    similar: [
      { word: 'academy', phonetic: '/əˈkædəmi/', meaning: 'n. 学院；研究院' },
      { word: 'academia', phonetic: '/ˌækəˈdiːmiə/', meaning: 'n. 学术界；学术生活' }
    ],
    enriched: true,
    enrichStatus: 'done'
  },
  {
    _id: 'w4',
    word: 'acknowledge',
    phoneticUS: '/əkˈnɒlɪdʒ/',
    phoneticUK: '/əkˈnɒlɪdʒ/',
    pos: 'v.',
    meaning: '承认；答谢',
    example: { en: 'She refused to acknowledge her mistake.', cn: '她拒绝承认自己的错误。' },
    roots: [
      { part: 'ac-', type: '前缀', meaning: '向' },
      { part: 'knowledge', type: '词根', meaning: '认知' }
    ],
    etymology: 'ac-（向）+ knowledge（知识），意为"使之进入认知"，即承认、确认。',
    // 形似词：空数组 —— 覆盖「暂缺」态（约 8.5% 的词库内无形似词）
    similar: [],
    enriched: true,
    enrichStatus: 'done'
  },
  {
    _id: 'w5',
    word: 'accommodate',
    phoneticUS: '/əˈkɒmədeɪt/',
    phoneticUK: '/əˈkɒmədeɪt/',
    pos: 'v.',
    meaning: '容纳；适应',
    // 边界态①：扩展内容暂缺（例句 / 词根 / 词源都没有）。
    // similar 字段也**故意不带** —— 覆盖「老数据 / 新导入词没有该字段」的降级路径。
    example: null,
    roots: [],
    etymology: '',
    enriched: false,
    enrichStatus: 'failed'
  },
  {
    _id: 'w6',
    word: 'ambiguous',
    phoneticUS: '/æmˈbɪɡjuəs/',
    phoneticUK: '/æmˈbɪɡjuəs/',
    pos: 'adj.',
    meaning: '模棱两可的',
    // 边界态②：扩展内容生成中。形似词给 1 条，覆盖「只有 1 个」态
    similar: [
      { word: 'ambitious', phonetic: '/æmˈbɪʃəs/', meaning: 'adj. 有雄心的；有野心的' }
    ],
    example: null,
    roots: [],
    etymology: '',
    enriched: false,
    enrichStatus: 'generating'
  }
]

const WORD_MAP = WORDS.reduce((m, w) => {
  m[w._id] = w
  return m
}, {})

/* ------------------------------------------------------------------ */
/* 题目：cn_option / en_option 交替。答案随题目下发（前端本地判题）      */
/* answerIndex / audioText 的含义见 cloudfunctions/build_questions.toClient */
/* ------------------------------------------------------------------ */

const QUESTIONS = [
  {
    id: 'w1_0',
    wordId: 'w1',
    type: 'cn_option',
    stem: 'abandon',
    phonetic: '/əˈbændən/',
    // D15：cn_option 带词根（题干区单词下方展示）
    roots: [
      { part: 'ab-', type: '前缀', meaning: '离开' },
      { part: 'bandon', type: '词根', meaning: '控制；命令' }
    ],
    options: ['放弃；抛弃', '抽象的', '学术的', '模棱两可的'],
    answerIndex: 0,
    audioText: 'abandon'
  },
  {
    id: 'w3_1',
    wordId: 'w3',
    type: 'en_option',
    stem: '学术的；学院的',
    phonetic: '',
    options: ['abstract', 'academic', 'abandon', 'acknowledge'],
    answerIndex: 1,
    audioText: 'academic'
    // en_option 刻意不带 roots：验证题干区不展示词根（露词根=给选项送答案）
  },
  {
    id: 'w4_2',
    wordId: 'w4',
    type: 'cn_option',
    stem: 'acknowledge',
    phonetic: '/əkˈnɒlɪdʒ/',
    roots: [
      { part: 'ac-', type: '前缀', meaning: '向' },
      { part: 'knowledge', type: '词根', meaning: '认知' }
    ],
    options: ['适应', '承认；答谢', '放弃', '抽象的'],
    answerIndex: 1,
    audioText: 'acknowledge'
  },
  {
    id: 'w2_3',
    wordId: 'w2',
    type: 'cn_option',
    stem: 'abstract',
    phonetic: '/ˈæbstrækt/',
    // 边界态：旧题（D15 前生成的队列）没有 roots 字段 → 不渲染词根区
    roots: [],
    options: ['学术的', '抽象的；摘要', '承认', '模棱两可的'],
    answerIndex: 1,
    audioText: 'abstract'
  }
]

/* ------------------------------------------------------------------ */
/* 工具：生成本月打卡日                                                  */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0')
}

function recentCheckedDays(count) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const today = now.getDate()
  const out = []
  for (let d = Math.max(1, today - count + 1); d <= today; d++) {
    out.push(`${y}-${pad(m + 1)}-${pad(d)}`)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 错题本                                                              */
/* ------------------------------------------------------------------ */

const WRONG_WORDS = [
  { _id: 'w4', word: 'acknowledge', phoneticUS: '/əkˈnɒlɪdʒ/', meaning: '承认；答谢' },
  { _id: 'w6', word: 'ambiguous', phoneticUS: '/æmˈbɪɡjuəs/', meaning: '模棱两可的' },
  { _id: 'w5', word: 'accommodate', phoneticUS: '/əˈkɒmədeɪt/', meaning: '容纳；适应' }
]

/* 错题列表在 mock 内部**可变**：dismiss_wrong 会真的摘掉一条，
   好让「点『已掌握』→ 列表少一个」这条交互在 USE_MOCK 下也能走通。
   （真实链路里由云端 records.mastered 过滤实现，见 dismiss_wrong 云函数） */
let wrongList = WRONG_WORDS.slice()

/* 用户累计态在 mock 内部**可变**：加练结算（finish_extra_round）与打卡
   都会累加 totalLearned。若这里写死常数，USE_MOCK 下「加练后累计学习 +N」
   就看不到，mock 与真机行为会分叉 —— 前端接线错了也发现不了。 */
const mockUser = { streak: 7, totalLearned: 168, dailyGoal: 5 }

/* ------------------------------------------------------------------ */
/* 每日一句（Daily Line）                                               */
/*                                                                     */
/* 选句标准：① 短（≤ 18 词，首页不占版面）② 可迁移——本身就是写作/   */
/* 口语可引用的素材 ③ 有一句中文对照，降低理解门槛                       */
/* tags 用高频话题，让用户知道这句能用在哪类题目上                   */
/*                                                                     */
/* ⚠️ 落地建议：这是**静态语料**，100 句足够轮一年，建议直接放前端        */
/*    utils/quotes.js 按日取模选句——不必新增云函数、零延迟、无个性化需求 */
/* ------------------------------------------------------------------ */

const DAILY_LINES = [
  {
    text: 'A different language is a different vision of life.',
    cn: '换一门语言，就是换一种看世界的方式。',
    author: 'Federico Fellini',
    tags: ['语言学习']
  },
  {
    text: 'It does not matter how slowly you go as long as you do not stop.',
    cn: '走得慢不要紧，只要不停下。',
    author: 'Confucius',
    tags: ['毅力', '坚持']
  },
  {
    text: 'It always seems impossible until it is done.',
    cn: '事情在做成之前，总显得不可能。',
    author: 'Nelson Mandela',
    tags: ['心态']
  },
  {
    text: 'We are what we repeatedly do.',
    cn: '我们由自己反复做的事塑造。',
    author: 'Aristotle',
    tags: ['习惯']
  },
  {
    text: 'Success is the sum of small efforts, repeated day in and day out.',
    cn: '成功是日复一日微小努力的总和。',
    author: 'Robert Collier',
    tags: ['坚持', '积累']
  },
  {
    text: 'The best time to plant a tree was twenty years ago. The second best time is now.',
    cn: '种一棵树最好的时间是二十年前，其次是现在。',
    author: 'Chinese Proverb',
    tags: ['行动', '时机']
  },
  {
    text: 'Great works are performed not by strength but by perseverance.',
    cn: '成就伟业靠的不是力量，而是坚持。',
    author: 'Samuel Johnson',
    tags: ['毅力']
  },
  {
    text: 'You do not have to see the whole staircase, just take the first step.',
    cn: '你不必看清整段楼梯，先迈出第一步就好。',
    author: 'Martin Luther King Jr.',
    tags: ['行动', '勇气']
  },
  {
    text: 'Little by little, one travels far.',
    cn: '一步一步，也能走得很远。',
    author: 'J. R. R. Tolkien',
    tags: ['积累']
  },
  {
    text: 'Learning is a treasure that will follow its owner everywhere.',
    cn: '学识是随身而行、永不褪色的财富。',
    author: 'Chinese Proverb',
    tags: ['学习']
  },
  {
    text: 'The way to get started is to quit talking and begin doing.',
    cn: '开始的办法，就是少说、动手做。',
    author: 'Walt Disney',
    tags: ['行动']
  },
  {
    text: 'The only limit to our realization of tomorrow is our doubts of today.',
    cn: '通往明天的唯一阻碍，是今天的犹疑。',
    author: 'Franklin D. Roosevelt',
    tags: ['心态', '勇气']
  }
]

/* ------------------------------------------------------------------ */
/* 各接口响应                                                          */
/* ------------------------------------------------------------------ */

function dailyLine() {
  const d = new Date()
  // 按日取模：同一天恒定同一句，跨天自动轮换
  const dayIndex = Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000
  )
  const q = DAILY_LINES[((dayIndex % DAILY_LINES.length) + DAILY_LINES.length) % DAILY_LINES.length]
  return {
    text: q.text,
    cn: q.cn,
    author: q.author,
    tags: q.tags,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
}

function homeSummary() {
  const base = {
    streak: mockUser.streak,
    totalLearned: mockUser.totalLearned,
    dailyGoal: mockUser.dailyGoal
  }
  if (SCENE === 'done') {
    return Object.assign(base, { learnedToday: 5, todayDone: true })
  }
  return Object.assign(base, { learnedToday: 2, todayDone: false })
}

/* ------------------------------------------------------------------ */
/* 加练（再学一组，M13 / 后端 T1）                                      */
/* 用模块内状态模拟「当日加练组」，覆盖 reused / pending / exhausted 边界态 */
/* ------------------------------------------------------------------ */

const EXTRA_GROUP_SIZE = 5
// ⚠️ 与云端一致：每日上限已取消（不限次数），limitReached 恒为 false。
//    保留该字段是因为前端 `index.js:buildExtra` 会读它。
const MAX_EXTRA_ROUNDS = Infinity
const mockExtra = { rounds: [] }

function extraSnapshot() {
  const rounds = mockExtra.rounds
  const pending = rounds.filter((r) => !r.done)
  return {
    rounds,
    pending,
    roundsToday: rounds.length - pending.length,
    extraLearnedToday: rounds.filter((r) => r.done).reduce((s, r) => s + r.wordIds.length, 0)
  }
}

function todayFlow(data) {
  if (data && data.action === 'markLearned') {
    return {} // 静默成功
  }
  if (SCENE === 'empty') {
    return {
      plan: { stage: 'done', newWordIds: [], extraRounds: [] },
      extra: {
        canStart: false,
        exhausted: true,
        limitReached: false,
        pendingRound: null,
        roundsToday: 0,
        extraLearnedToday: 0,
        groupSize: EXTRA_GROUP_SIZE
      }
    }
  }
  if (SCENE === 'done') {
    const s = extraSnapshot()
    return {
      plan: {
        stage: 'practice_done',
        newWordIds: [],
        // 只给 learn 页取 wordIds 用，不含 practiceQueue（与 today_flow 的下发口径一致）
        extraRounds: s.rounds.map((r) => ({
          roundId: r.roundId,
          wordIds: r.wordIds,
          learnedIds: r.done ? r.wordIds : [],
          stage: r.done ? 'done' : 'learning'
        }))
      },
      extra: {
        canStart: true,
        exhausted: false,
        limitReached: s.rounds.length >= MAX_EXTRA_ROUNDS,
        pendingRound: s.pending.length ? { roundId: s.pending[s.pending.length - 1].roundId } : null,
        roundsToday: s.roundsToday,
        extraLearnedToday: s.extraLearnedToday,
        groupSize: EXTRA_GROUP_SIZE
      }
    }
  }
  // progress：学了一半，剩余 6 张卡（未打卡 → D1=A 不显示加练）
  return {
    plan: { stage: 'learning', newWordIds: WORDS.map((w) => w._id), extraRounds: [] },
    extra: {
      canStart: false,
      exhausted: false,
      limitReached: false,
      pendingRound: null,
      roundsToday: 0,
      extraLearnedToday: 0,
      groupSize: EXTRA_GROUP_SIZE
    }
  }
}

function startExtraRound() {
  if (SCENE === 'empty') {
    return { roundId: null, wordIds: [], reused: false, exhausted: true }
  }
  // 幂等：有未完成的组就原样返回（连点两次只创建一组）
  const pending = mockExtra.rounds.filter((r) => !r.done)
  if (pending.length) {
    const g = pending[pending.length - 1]
    return { roundId: g.roundId, wordIds: g.wordIds, reused: true, exhausted: false }
  }
  const roundId = mockExtra.rounds.length + 1
  const wordIds = WORDS.map((w) => w._id)
  mockExtra.rounds.push({ roundId, wordIds, done: false })
  return { roundId, wordIds, reused: false, exhausted: false }
}

function finishExtraRound(data) {
  const roundId = Number(data && data.roundId) || 0
  const g = mockExtra.rounds.filter((r) => r.roundId === roundId)[0]
  const already = !!(g && g.done)
  const learnedCount = g ? g.wordIds.length : 0
  // 计入累计学习；already 时不再累加（对应云端 stage==='done' 的幂等分支）
  if (g && !already) {
    mockUser.totalLearned += learnedCount
    g.done = true
  }
  return { roundId, learnedCount, totalLearned: mockUser.totalLearned, already }
}

function userProfile(data) {
  const goal = data && data.action === 'setGoal' ? data.dailyGoal : 5
  return { dailyGoal: goal, onboarded: true, createdAt: '2026-09-01' }
}

function startNewWords() {
  if (SCENE === 'empty') return { newWordIds: [] }
  return { newWordIds: WORDS.map((w) => w._id) }
}

function wordCard(data) {
  const id = data && data.wordId
  const w = WORD_MAP[id]
  if (!w) {
    // 未命中：返回一个极简卡，避免页面崩。
    // similar 给空数组：未命中的词没有形似词数据，页面走「暂缺」。
    return { _id: id, word: id, phoneticUS: '', phoneticUK: '', pos: '', meaning: '', example: null, roots: [], etymology: '', similar: [], enriched: false, enrichStatus: 'failed' }
  }
  // 生成中态：给页面 enriching=true 的字段
  if (w.enrichStatus === 'generating') {
    return Object.assign({}, w, { enriching: true })
  }
  return w
}

function buildQuestions() {
  return { questions: QUESTIONS }
}

/* 落库用的判题（前端已本地判过一次，这里与云端 submit_answer 一样再判一次并回同样字段） */
function submitAnswer(data) {
  const idx = data && typeof data.questionIndex === 'number' ? data.questionIndex : 0
  const choice = data && typeof data.choice === 'number' ? data.choice : -1
  const q = QUESTIONS[idx] || {}
  const answer = typeof q.answerIndex === 'number' ? q.answerIndex : 0
  return { correct: choice === answer, answerIndex: answer, word: q.audioText || '' }
}

function finishCheckin() {
  const already = SCENE === 'done'
  const learnedCount = 5
  // 打卡也计累计（already 时幂等，不重复加）
  if (!already) mockUser.totalLearned += learnedCount
  return { streak: mockUser.streak + 1, learnedCount, totalLearned: mockUser.totalLearned, already }
}

function stats() {
  return {
    streak: mockUser.streak,
    totalLearned: mockUser.totalLearned,
    totalCheckins: 23,
    dates: recentCheckedDays(7),
    wrongWords: wrongList
  }
}

/**
 * 错题本「已掌握」（dismiss_wrong）：真的从列表摘掉一条，让 UI 能观察到变化。
 * 幂等：重复点同一个词不会报错，updated 为 0。
 */
function dismissWrong(data) {
  const id = data && data.wordId
  const before = wrongList.length
  wrongList = wrongList.filter((x) => x._id !== id)
  return { wordId: id, updated: before - wrongList.length }
}

/* ------------------------------------------------------------------ */
/* 路由：name + data → { code, data, message }                         */
/* ------------------------------------------------------------------ */

const FN = config.FN

function dispatch(name, data) {
  switch (name) {
    case FN.HOME_SUMMARY:
      return homeSummary()
    case FN.TODAY_FLOW:
      return todayFlow(data)
    case FN.USER_PROFILE:
      return userProfile(data)
    case FN.START_NEW_WORDS:
      return startNewWords()
    case FN.WORD_CARD:
      return wordCard(data)
    case FN.BUILD_QUESTIONS:
      return buildQuestions()
    case FN.SUBMIT_ANSWER:
      return submitAnswer(data)
    case FN.FINISH_CHECKIN:
      return finishCheckin()
    case FN.START_EXTRA_ROUND:
      return startExtraRound()
    case FN.FINISH_EXTRA_ROUND:
      return finishExtraRound(data)
    case FN.STATS:
      return stats()
    case FN.DISMISS_WRONG:
      return dismissWrong(data)
    case FN.DAILY_LINE:
      return dailyLine()
    default:
      return null
  }
}

/**
 * 模拟一次云函数调用
 * @returns {Promise<{code:number, data:any, message:string}>} 与云函数返回结构一致
 *          resolve(null) 表示未命中，调用方应继续走真实链路
 */
function handle(name, data) {
  const payload = dispatch(name, data)
  if (payload == null) return Promise.resolve(null)
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ code: 0, data: payload, message: '' })
    }, DELAY)
  })
}

/**
 * 发音 mock：单词返回 dictvoice URL（能响），例句返回 null（静默）
 * 与 audio.js 的真实三层缓存对齐：单词总有声、例句未预置时静默
 * @param {'word'|'sentence'} kind
 */
function audioSrc(text, type, kind) {
  if (kind === 'sentence') return null
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=${type}`
}

module.exports = {
  handle,
  audioSrc,
  // 暴露给调试：当前场景与词表，便于在控制台查看
  getScene: () => SCENE,
  getWords: () => WORDS,
  getLines: () => DAILY_LINES,
  getWrongWords: () => wrongList
}
