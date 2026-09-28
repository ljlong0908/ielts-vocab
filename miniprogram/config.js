/**
 * 全局配置
 * ⚠️ 首次使用请替换 ENV_ID 与 project.config.json 中的 appid
 */
module.exports = {
  // 云开发环境 ID（微信开发者工具 → 云开发 → 环境设置 中查看）
  ENV_ID: 'cloud1-d3g7gz4uo668f8faa',

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
    AUDIO_CACHE: 'audio_cache'
  }
  // 题型标识（cn_option / en_option）只在云函数 build_questions / submit_answer 内部流转，
  // 前端不参与判断，故不在 config 里重复声明。
}
