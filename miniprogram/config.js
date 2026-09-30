/**
 * 全局配置
 * ⚠️ 首次使用请替换 ENV_ID 与 project.config.json 中的 appid
 */
module.exports = {
  // 云开发环境 ID（微信开发者工具 → 云开发 → 环境设置 中查看）
  ENV_ID: 'cloud1-d3g7gz4uo668f8faa',

  // UX 优化开关：true 时所有云函数调用与发音走本地 mock（utils/mock.js），不联网
  // 调 UI / 原型打磨时开，接真接口时关
  USE_MOCK: false,

  // mock 场景（仅 USE_MOCK=true 时生效）：'progress' | 'done' | 'empty'
  MOCK_SCENE: 'progress',

  // 每日目标可选项
  DAILY_GOAL_OPTIONS: [5, 10],

  // 发音语言（en_US 美音 / en_GB 英音）
  TTS_LANG: 'en_US',

  // 云函数名常量
  FN: {
    USER_PROFILE: 'user_profile',
    HOME_SUMMARY: 'home_summary',
    TODAY_FLOW: 'today_flow',
    START_NEW_WORDS: 'start_new_words',
    WORD_CARD: 'word_card',
    BUILD_QUESTIONS: 'build_questions',
    SUBMIT_ANSWER: 'submit_answer',
    FINISH_CHECKIN: 'finish_checkin',
    STATS: 'stats',
    DAILY_LINE: 'daily_line',
    AUDIO_CACHE: 'audio_cache',
    // 加练（再学一组，M13/T1）
    START_EXTRA_ROUND: 'start_extra_round',
    FINISH_EXTRA_ROUND: 'finish_extra_round',
    // 错题本「已掌握」（把词移出错题本；之后再答错会自动回来）
    DISMISS_WRONG: 'dismiss_wrong'
  }
  // 题型标识（cn_option / en_option）只在云函数 build_questions / submit_answer 内部流转，
  // 前端不参与判断，故不在 config 里重复声明。
}
