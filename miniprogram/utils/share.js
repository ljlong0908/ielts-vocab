/**
 * 分享转发配置（统一入口）
 *
 * 设计约定：
 * 1. 只开启「转发给朋友 / 群」（onShareAppMessage），**不开启朋友圈**（onShareTimeline）。
 *    朋友圈打开的是「单页模式」：无登录态、不允许跳转，且云开发必须开启「未登录访问」
 *    才能读到数据。本项目所有数据都依赖 openid，单页模式下必然空白，而放开未登录
 *    访问会带来越权读写风险。故不启用。
 * 2. 所有页面的分享路径统一回首页（pages/index/index）。learn / practice / checkin
 *    是强流程页，新用户从分享卡片直接进入会立刻创建当日学习计划，体验突兀；
 *    回首页最干净——未设置目标的新用户会被 index 自动引导到 onboarding。
 * 3. 分享文案只描述功能，不含「分享得奖励」「帮我点一下」等诱导性表述，避免触碰
 *    《微信小程序平台运营规范》中关于诱导分享的条款。
 */

const BRAND = '雅词本'
const HOME_PATH = '/pages/index/index'

// 分享卡片配图（建议 5:4，500x400）。
// 留空则使用系统默认：页面截图 + 小程序 Logo，效果可接受。
// 需要自定义时：把图片放到 miniprogram/images/share.png，再把下面这行改成 '/images/share.png'
const SHARE_IMAGE = ''

/**
 * 生成「转发给朋友」的分享配置
 * @param {Object} [opts]
 * @param {string} [opts.title]    分享标题，缺省用品牌默认文案
 * @param {string} [opts.path]     分享路径，缺省回首页
 * @param {string} [opts.imageUrl] 自定义配图，缺省用全局配置
 * @returns {{title: string, path: string, imageUrl?: string}}
 */
function toFriend(opts) {
  const o = opts || {}
  const res = {
    title: o.title || `${BRAND}｜每天记住几个雅思词`,
    path: o.path || HOME_PATH
  }
  const img = o.imageUrl || SHARE_IMAGE
  if (img) res.imageUrl = img
  return res
}

// HOME_PATH / BRAND 仅在本文件内部使用，不外暴露（外部只需 toFriend）
module.exports = { toFriend }
