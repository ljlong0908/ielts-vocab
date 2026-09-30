# 贡献指南

感谢愿意一起把「雅词本」做得更扎实。动手前请先花两分钟读完本文。

## 开始之前

- **微信开发者工具**（需含云开发能力），以及你自己的小程序 AppID
- 本地脚本用 **Node** 与 **Python 3** 运行（开发环境：Node 22 / Python 3.13）

- 部署与上线步骤见 **[docs/deploy.md](docs/deploy.md)**（唯一权威操作清单）
- 项目结构与业务逻辑见 **[docs/project-spec.md](docs/project-spec.md)**（**以源码为准**，供 AI 当上下文）

## 本地跑起来

1. `cp .env.example .env`，填 `WX_APPID` / `ENV_ID` / `WX_APP_SECRET`
2. 开发者工具导入**仓库根**（含 `project.config.json`），填入自己的 AppID
3. 开通云开发，把环境 ID 填进 `miniprogram/config.js` 的 `ENV_ID`
4. 按 `docs/deploy.md` 部署云函数 → 初始化数据表 → 导入词表与音频

> **只想调 UI**：把 `miniprogram/config.js` 的 `USE_MOCK` 设为 `true`，所有云函数调用与发音改走 `utils/mock.js`，全程不联网。

Python 依赖见 `scripts/requirements.txt`。

## 提交前请跑一遍

没有测试框架，每个脚本都是独立的 `node` 程序，**退出码非 0 即失败**：

```bash
node scripts/check_miniprogram.js        # 结构自检：类名 / 底栏三件套 / 图标 / wxml 配对 / 云函数三件套
node scripts/test_learn.js               # 学习页三模式（错题复习 / 今日新词 / 加练）
node scripts/test_index.js               # 首页「再学一组」显隐
node scripts/test_wrongbook.js           # 错题本（点词进复习 / 已掌握 / 失败回滚）
node scripts/test_audio.js               # 音频链路（cloud:// 真机截断 / 缓存 / 降级）
node scripts/test_mock.js                # mock 层数据口径 + 每日一句体检
node scripts/test_start_extra_round.js   # 加练发起（云函数逻辑：桩掉 wx-server-sdk + 内存假 DB）
node scripts/test_finish_extra_round.js  # 加练结算（同上）
```

改了哪块就至少跑对应那一支；**动了云函数务必跑最后两支**。

> 新增测试请复用两份共享骨架，别在测试文件里另抄一遍：
> `scripts/_harness.js`（页面级：断言计数 / `stub()` / `installWx()` / `loadPage()`）、
> `scripts/_fn_harness.js`（云函数级：内存假 DB + `wx-server-sdk` 桩 + `loadFn()`）。
> 各写各的桩会让「同一件事在两个测试里行为不同」，失败信号互相矛盾。

> ⚠️ `scripts/audit_mobile.js` 与 `scripts/test_prototype.js` **只审 `design/prototype.html`**，
> 对 `miniprogram/` 零验证力 —— 别拿它们当小程序通过的证据。

### 改断言时必须做负向验证

新增或修改断言后，**故意把源码改坏一次，确认它真的会 FAIL**。
这套脚本用桩件直跑真实页面，很容易写出「永远为绿」的假断言 —— 本项目已踩过这个坑。

## 代码约定

- **文案禁用「雅思」**：该词是他人注册商标，产品内外统一用「雅词本 / 核心词」。
  `grep -rn "雅思" miniprogram/` 必须 0 命中。
- **新云函数必须三件套齐全**：`index.js` + `config.json` + `package.json`（声明 `wx-server-sdk`）。
  漏 `package.json` 会上传成功、一调用即报 `Cannot find module 'wx-server-sdk'`（`-504002`）。
- **跨运行时同值**：`gen_audio.py` / `seed_audio.py` 的 `slug()`、`hashText()` 与相关正则必须三处同步，
  否则音频对不上号。
- **前端不得静默隐藏 UI**：后端缺字段时走降级并显式提示，不要「按钮凭空消失」。
- **绝不提交密钥**：`sk-` 明文、AppSecret、`ADMIN_TOKEN` 一字都不许入库。
  `build/`、`.env`、`.workbuddy/` 已在 `.gitignore` 中，也不要手工加回。
- **改动行为就顺手更新 `docs/project-spec.md`**，但不要往里堆流水账。

## 提交与 PR

- 提交信息用 `<type>: <说明>` 前缀（`feat` / `fix` / `docs` / `chore` / `refactor`），正文说清「为什么」
- 一个 PR 只做一件事；大改动请先开 issue 对齐
- 新增行为请带上对应的回归断言，并在 PR 描述里贴出脚本输出
