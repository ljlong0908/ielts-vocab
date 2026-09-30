/**
 * 每日一句（M12）——纯前端静态语料，零后端、零延迟
 *
 * 为什么不走云函数：同一句对所有用户无差别，没有个性化需求；后端化只会增加
 * 冷启动延迟（首屏要多等一次网络）。按日取模轮换即可，跨天自动换句。
 *
 * 选句硬标准（加句必须遵守，scripts/test_mock.js 已做自动体检）：
 *   ① ≤ 18 词（首页卡片不占版面）
 *   ② 可迁移 —— 本身就是写作/口语可引用的素材
 *   ③ 必配中文对照（降低理解门槛）
 * tags 用高频话题，让用户知道这句能用在哪类题目上。
 *
 * 语料与 utils/mock.js 的 DAILY_LINES 同源（mock 只用于调试，此处是交付路径）。
 */
const LINES = [
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

/** 今日选句：同一天恒定同一句，跨天自动轮换 */
function today() {
  const d = new Date()
  const dayIndex = Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000
  )
  const i = ((dayIndex % LINES.length) + LINES.length) % LINES.length
  return LINES[i]
}

module.exports = { LINES, today }
