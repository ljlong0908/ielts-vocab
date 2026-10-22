/**
 * app.js 自动更新逻辑自测（node 直跑，零依赖、不连云）
 * 用法：node scripts/test_app_update.js
 *
 * 为什么单测它：发版后自动更新是用户明确要的功能（2026-10-13），而它的三个
 * 回调（onCheckForUpdate / onUpdateReady / onUpdateFailed）在真机上要等微信
 * 客户端调度，本地只能靠桩验证「绑没绑、弹不弹、调不调 applyUpdate」。
 * 本测试钉四件事：
 *   ① onLaunch 把三个更新回调都绑上 —— 漏绑 = 静默不更新，本项目头号坑
 *   ② onUpdateReady → showModal(showCancel:false) → 确认后 applyUpdate
 *      （不可取消：唯一的动作就是重启，不给「稍后」这种空动作）
 *   ③ onUpdateFailed → 静默：不弹窗、不重启、不抛错（下次冷启动微信会重试）
 *   ④ 低版本基础库没有 getUpdateManager → onLaunch 不炸，其余初始化照常
 *
 * 共享骨架（wx 桩 / 断言计数器）见 scripts/_harness.js；
 * app.js 依赖的 config 与 utils/audio 用 stub() 顶掉，只测 app 自己的逻辑。
 */
const path = require('path')
const { ROOT, drain, tester, stub, installWx } = require('./_harness')

// app.js 依赖的两个模块用桩顶掉：config 只提供 ENV_ID，audio 只记 warmup 次数
let warmupCount = 0
let cloudInitCalls = 0
stub('miniprogram/config', { ENV_ID: 'test-env' })
stub('miniprogram/utils/audio', { warmup: () => { warmupCount++ } })

/** 假更新管理器：三个 on* 各记一个回调，applyUpdate 记调用次数 */
function fakeUpdateManager() {
  const um = {
    listeners: {},
    applyUpdateCalls: 0,
    onCheckForUpdate(cb) { um.listeners.check = cb },
    onUpdateReady(cb) { um.listeners.ready = cb },
    onUpdateFailed(cb) { um.listeners.failed = cb },
    applyUpdate() { um.applyUpdateCalls++ }
  }
  return um
}

/** 重新加载真实 app.js 并接住 App(cfg)（每个用例都要全新的，避免监听/计数串味） */
function loadApp() {
  let app = null
  global.App = (cfg) => { app = cfg }
  delete require.cache[require.resolve(path.join(ROOT, 'miniprogram/app.js'))]
  require(path.join(ROOT, 'miniprogram/app.js'))
  return app
}

/** 装 wx 桩 + 跑 onLaunch，返回 { app, um, modalArgs } */
function boot(wxOver = {}) {
  warmupCount = 0
  cloudInitCalls = 0
  let modalArgs = null
  const um = fakeUpdateManager()
  installWx(Object.assign(
    {
      cloud: { init: () => { cloudInitCalls++ } },
      getUpdateManager: () => um,
      showModal(args) {
        modalArgs = args
        setTimeout(() => args.success({ confirm: true }), 0)
      }
    },
    wxOver
  ))
  const app = loadApp()
  app.onLaunch()
  return { app, um, getModalArgs: () => modalArgs }
}

const { t, done } = tester()

;(async () => {
  /* ===== 用例 1：onLaunch 初始化 cloud + warmup + 绑三个更新回调 ===== */
  const b1 = boot()
  t('onLaunch：wx.cloud.init 被调用', cloudInitCalls === 1)
  t('onLaunch：audio.warmup 被调用（冷启动预热 audio_cache）', warmupCount === 1)
  t('onLaunch：三个更新回调都绑上（漏绑 = 静默不更新）',
    typeof b1.um.listeners.check === 'function' &&
    typeof b1.um.listeners.ready === 'function' &&
    typeof b1.um.listeners.failed === 'function')

  /* ===== 用例 2：onCheckForUpdate / onUpdateFailed 回包不抛错 ===== */
  let err = null
  try {
    b1.um.listeners.check({ hasUpdate: true })
    b1.um.listeners.failed()
  } catch (e) { err = e }
  t('onCheckForUpdate / onUpdateFailed：回包不抛错', err === null)
  t('onUpdateFailed：不弹窗、不重启（静默等下次冷启动重试）',
    b1.getModalArgs() === null && b1.um.applyUpdateCalls === 0)

  /* ===== 用例 3：onUpdateReady → 弹窗(不可取消) → 确认后 applyUpdate ===== */
  b1.um.listeners.ready()
  await drain()
  const args = b1.getModalArgs()
  t('onUpdateReady：弹更新提示窗', args !== null)
  t('onUpdateReady：showCancel=false（唯一动作就是重启，不给空动作）',
    args && args.showCancel === false)
  t('onUpdateReady：confirmText=立即重启（文案契约）',
    args && args.confirmText === '立即重启')
  t('onUpdateReady：确认后 applyUpdate 被调用（新版本立即生效）',
    b1.um.applyUpdateCalls === 1)

  /* ===== 用例 4：低版本基础库没有 getUpdateManager → 不炸，其余照常 ===== */
  let err4 = null
  try {
    boot({ getUpdateManager: undefined })
  } catch (e) { err4 = e }
  t('低版本基础库：onLaunch 不抛错', err4 === null)
  t('低版本基础库：cloud.init / warmup 照常（更新走微信默认行为）',
    cloudInitCalls === 1 && warmupCount === 1)

  done()
})()
