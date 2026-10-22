const config = require('./config')
const audio = require('./utils/audio')

// 用户信息由各页面按需通过 api.getProfile() 获取，全局不缓存用户态
// （云函数侧以 OPENID 为准，前端缓存反而会读到过期数据）
App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库版本过低，请使用 2.2.3 及以上版本')
      return
    }
    wx.cloud.init({
      env: config.ENV_ID,
      traceUser: true
    })
    // 预热 audio_cache 云函数实例：首次发音的大部分等待其实是云函数冷启动，
    // 这里在启动时就先叫醒它（空文本会被立刻拒绝，不写库不外呼）。
    audio.warmup()
    this.checkUpdate()
  },

  /**
   * 发版后自动更新（2026-10-13 用户要求）
   *
   * 机制：微信客户端本来就会在小程序冷启动时异步检查并下载新版本，但**默认要等
   * 下一次冷启动才生效**（用户得自己杀进程重进）。这里用 UpdateManager 在
   * 「新版本下载完成」时立即提示重启，点一下即用上新版本。
   *
   * 三个取舍（改之前先读）：
   *  ① 只在 onLaunch 绑一次 —— `wx.getUpdateManager()` 返回**全局唯一**实例，
   *     在 onShow 里重复绑会叠加监听、同一更新连弹好几次窗；
   *  ② 用 showModal(showCancel:false) 而不是直接 applyUpdate() —— 直接重启会
   *     硬切串行落库链（syncAnswer 在途的那条 submit_answer 会丢），弹窗让用户
   *     自己挑时机点，代价只是多一下点击；
   *  ③ 低版本基础库没有 getUpdateManager 时静默返回 —— 那些客户端走微信默认
   *     行为（下次冷启动生效），不影响使用。
   */
  checkUpdate() {
    if (!wx.getUpdateManager) return
    const um = wx.getUpdateManager()
    um.onCheckForUpdate((res) => {
      console.log('[update] 检查更新：', res && res.hasUpdate ? '有新版本，后台下载中' : '已是最新')
    })
    um.onUpdateReady(() => {
      wx.showModal({
        title: '发现新版本',
        content: '新版本已下载完成，重启后生效',
        showCancel: false,
        confirmText: '立即重启',
        success: () => um.applyUpdate()
      })
    })
    um.onUpdateFailed(() => {
      // 下载失败不打扰用户：微信客户端下次冷启动会重新检查下载
      console.warn('[update] 新版本下载失败，下次启动会自动重试')
    })
  }
})
