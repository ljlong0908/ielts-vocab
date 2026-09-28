const config = require('./config')

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
  }
})
