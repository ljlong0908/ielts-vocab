# 雅词本 · 核心词汇微信小程序

> **一个不花服务器钱、个人主体也能上线的背单词小程序。**
> 发音 100% 自持（本地 Kokoro 预生成 → 云存储，运行时零外呼），AI 内容按需生成 + 缓存，
> 18 个云函数 + 全套幂等部署脚本，开箱可跑。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Platform: WeChat MiniProgram](https://img.shields.io/badge/Platform-WeChat%20MiniProgram-07C160.svg)
![Backend: CloudBase](https://img.shields.io/badge/Backend-CloudBase-006EFF.svg)
![TTS: Kokoro-82M](https://img.shields.io/badge/TTS-Kokoro--82M-orange.svg)
[![PRs: Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**核心闭环**：微信登录 → 设置每日目标 → 复习昨日单词 → 学今日新词 → 做题检验 → 全对打卡 → 次日循环

**快速跳转**：[它解决什么问题](#它解决什么问题) · [能抄走的工程模式](#能抄走的工程模式) · [快速开始](#快速开始) · [部署文档](docs/deploy.md) · [贡献指南](CONTRIBUTING.md)

---

## 它解决什么问题

做一款「带发音的背单词小程序」，个人开发者通常会撞上这五堵墙：

| 拦路虎 | 本项目的做法 |
|---|---|
| 小程序要做**单词发音**，而微信同声传译插件 **仅对企业主体开放** | 改用本地 **Kokoro-82M**（Apache-2.0）离线预生成音频 → 云存储分发，**个人主体完全可用**，运行时不外呼 |
| 不想买服务器、不想折腾备案域名 | 全栈 **微信云开发 CloudBase**（云函数 + 云数据库 + 云存储），**零服务器、零备案域名** |
| 怕 AI 生成内容**烧 token** | `enriched` 标记 + **乐观锁** + 定时重试 —— 同一份内容**全局只生成一次**，命中即读库 |
| 数据导入全靠手点控制台，无法复现 | 全套 **幂等 Python 脚本**：建表建索引、导入词表/例句/音频、一键部署云函数，失败可重跑 |
| 小程序没有官方单元测试框架 | `node scripts/test_*.js` **桩件直跑真实页面 JS 与真实云函数**，退出码即结果 |

这五条就是本仓库的技术含量所在，展开在下一节。

---

## 能抄走的工程模式

1. **用本地 TTS 绕开主体限制。**
   同声传译插件（WechatSI）只对企业主体开放，个人开发者没有官方路径。这里改成
   **本机合成 + 云存储分发**：`gen_audio.py`（Kokoro-82M）批量生成 mp3，`seed_cloud.py` 直传云存储，
   运行期只做一次 `getTempFileURL`。结果是**零外呼、无第三方限流、无版权灰区**，
   顺带把每次播放的成本压到 0。

2. **AI 内容按需生成 + 乐观锁 + 定时重试。**
   `words.enriched === true` → 直接读库，绝不调模型；未生成则用 `enrichStatus: pending → generating`
   的**乐观锁**保证同一单词全局只生成一次；失败降级返回词表基础字段，交给每天 03:00 的
   **定时任务**重试并释放超时锁。配合 `msgSecCheck` 内容安全检测后才写回。

3. **把「音频就绪」做成出词闸门。**
   出词条件是 `seq > wordCursor && audioReady === true`。于是可以**先导入全量词表、再分批点亮音频**，
   两者互不阻塞。代价是两条硬约束：`wordCursor` **必须按 seq 推进**（不能按词数累加，否则过滤后错位重复出词），
   音频也必须**按 seq 从前往后连续**生成。

4. **把一整天的状态机塞进一个文档，旁路功能内嵌数组。**
   `daily_plans.stage: review → learning → practice → practice_done → done` 串起闭环；
   「加练」作为旁路**内嵌 `daily_plans.extraRounds[]`**，既绕开 `_openid + date` 唯一索引，
   也做到**不写 `checkins` / 不动 `streak`**——加练再多也不污染当日的打卡口径。

5. **没有测试框架也能做回归。**
   `scripts/test_*.js` 用 `require.cache` 注入桩件，**直接 require 真实页面 JS**；
   云函数测试用 `Module._load` 拦截 `wx-server-sdk` + 内存假 DB，**直跑真实 `cloudfunctions/*/index.js`**。
   不用装 Jest / Vitest，也不用手工在开发者工具里点。

6. **部署脚本化且幂等。**
   `init_cloud.py`（建 7 集合 + 10 索引）、`seed_cloud.py`（词表 + 例句 + 音频 + 点亮 `audioReady`）、
   `deploy_functions.py`（走开发者工具 CLI，**默认只传改动过的**）——都能重复跑，失败重跑不会写坏数据。

---

## 功能一览

| 模块 | 说明 |
|---|---|
| 每日闭环 | 复习 → 学新词 → 中选项 / 英选中交替出题 → **服务端判题**（答案不下发） → 全对打卡 |
| 加练「再学一组」 | 打卡后可无限加练，唯一终点是词库取尽；结算时按整组计入「累计学习」 |
| 错题本 | 错词自动入本，可「已掌握」移出（**再答错自动复活**），点词直接进复习 |
| 每日一句 | 首页轮播金句 + 发音，12 句预置音频，纯前端零延迟 |
| 发音 | 进词自动朗读，全链路离线音频 + 前端 fileID 缓存 |
| 统计 | 连续打卡 / 累计学习 / 正确率 |
| 分享 | 好友转发（全页）+ 朋友圈（仅首页，含单页模式降级） |

## 演示

8 个页面（引导 / 首页 / 学习 / 练习 / 打卡 / 统计 / 错题本 / 我的）**全部还原在
[`design/prototype.html`](design/prototype.html)** —— 浏览器直接打开，点着走完整个闭环，**不需要部署、不需要账号**。

> 仓库暂未附真机截图与演示 GIF（见[路线图](#路线图)）。原型是当前最快的一手体验方式。

---

## 架构

```
微信小程序（miniprogram/ ，8 页 + 原生 tabBar）
        │  wx.cloud.callFunction
        ▼
云函数 ×18（cloudfunctions/） ──────► 云数据库 ×7
        │                              users / words / user_words / daily_plans
        │                              records / checkins / audio_cache
        ▼
云存储：离线音频（单词 / 例句 / 每日一句），配 audio_cache 索引跨用户共享

离线侧（只在本机跑，不进包体、不进云函数）：
  ECDICT ──build_wordlist──► 词表 ──gen_examples(DeepSeek)──► 例句 / 词根 / 词源
                          └──gen_audio(Kokoro-82M)──► mp3 ──seed_cloud──► 云存储 + 数据库
```

## 快速开始

完整步骤见 **[docs/deploy.md](docs/deploy.md)**（唯一权威操作清单，含验收表 / 报错排查 / 提审检查）。
这里是骨架。本地工具链的凭证统一放项目根 `.env`（先 `cp .env.example .env`）：

1. **导入项目** —— 开发者工具选**仓库根**（含 `project.config.json`），填入自己的 AppID
2. **开通云开发** —— 复制环境 ID，填进 `miniprogram/config.js` 的 `ENV_ID`
3. **配环境变量** —— `ADMIN_TOKEN`（5 个函数各配一遍）+ `DEEPSEEK_API_KEY`（只配 `enrich_word`）。**环境变量是函数级隔离的，最容易漏**
4. **部署云函数** —— 一条命令 `python3 scripts/deploy_functions.py --all`（需先在「设置 → 安全设置」打开**服务端口**）；或 18 个目录逐个「上传并部署：云端安装依赖」
5. **初始化数据表** —— 本地一键 `python3 scripts/init_cloud.py --apply`（建 7 个集合 + 10 条索引，幂等）。控制台跑 `init_db` 是等价备选，但它**只能建集合、不能建索引**，索引仍需自己补
6. **导入词表与音频** —— 本地一键 `python3 scripts/seed_cloud.py --apply`（词表 + 例句富化 + 音频 + 点亮 `audioReady`，幂等；`--reset` 会先备份再清空重导）。音频是**本地预生成后直传**，不走云函数
7. **配集合权限（手工一次）** —— 云开发控制台 → 数据库 → 集合 → 权限设置，口径见 `docs/deploy.md` §5.3（HTTP API 没有权限接口，只能手点）
8. **编译预览**

想先只跑通闭环？仓库自带 **`assets/word_lists/pilot-100.json`（100 词）** 作为最小数据集，
跑完第 6 步即可，之后再按 `seq` 顺序增量补音频。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| **[docs/deploy.md](docs/deploy.md)** | **部署与上线步骤 —— 唯一权威操作清单**，从零到可用，含验收表 / 报错排查 / 提审检查 |
| [docs/project-spec.md](docs/project-spec.md) | 项目结构与业务逻辑说明（**以源码为准**，供 AI 作为上下文） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南：本地环境、回归自测、代码约定 |
| [.env.example](.env.example) | 本地环境变量模板（复制为 `.env` 后填写，`.env` 不入库） |
| [design/tokens.html](design/tokens.html) | 视觉规范：颜色 token / 字号 / 触控热区 |
| [docs/隐私保护指引.md](docs/隐私保护指引.md) | 隐私合规文案（**示例**，提审用） |
| [docs/intro.md](docs/intro.md) | 小程序简介文案（**示例**，市场介绍 / 分享文案） |

> 上手看本文件，动手部署直接翻 `docs/deploy.md`。

---

## 云函数清单（18 个）

<details>
<summary>展开：前端调用 13 个 / 服务端与管理 5 个（每个都自带 config.json 声明超时）</summary>

**前端调用（13）**

| 函数 | 作用 | 超时 |
|---|---|---|
| `user_profile` | 登录 + 每日目标 | 20s |
| `home_summary` | 首页聚合数据 | 20s |
| `today_flow` | 当日流程状态机（前端唯一状态来源，含加练聚合 `extra`） | 20s |
| `start_new_words` | 幂等生成当日新词队列 | 20s |
| `word_card` | 单词卡（触发 AI 补全） | 30s |
| `build_questions` | 生成题目（**答案留在服务端**；`round>0` 出加练题） | 30s |
| `submit_answer` | 服务端判题 + 推进复习池（`round>0` 判加练题） | 20s |
| `finish_checkin` | 打卡（幂等） | 30s |
| `start_extra_round` | 发起加练「再学一组」（幂等，需当日已打卡） | 30s |
| `finish_extra_round` | 结算加练组（推进游标 + 计入累计学习；**不写** checkins/streak/stage） | 30s |
| `stats` | 统计与错题数据 | 30s |
| `audio_cache` | 音频读缓存（命中直接返回 fileID） | 20s |
| `dismiss_wrong` | 错题本「已掌握」：给 `records` 打标记，词移出错题本（以后再答错自动回来） | 10s |

**服务端 / 管理调用（5）**

| 函数 | 作用 | 调用方 | 超时 |
|---|---|---|---|
| `enrich_word` | AI 内容补全（带乐观锁 + 缓存 + 定时重试） | `word_card` 服务端调 + 定时器 | 30s |
| `seed_words` | 词表导入（幂等，永不覆盖） | 控制台 | 60s |
| `seed_audio` | 音频入库 + 点亮 `audioReady` | 控制台 | 60s |
| `reset_words` | 词库重置（破坏性，需二次确认） | 控制台 | 60s |
| `init_db` | 数据表初始化 / 体检（幂等） | 控制台 | 60s |

数据库集合：`users` / `words` / `user_words` / `daily_plans` / `records` / `checkins` / `audio_cache`。

</details>

## 核心机制（速览）

> 完整的字段级说明、状态迁移与取舍理由见 [docs/project-spec.md](docs/project-spec.md) §7，这里只留结论。

- **出词**：按 `words.seq` 升序取「`seq > wordCursor` 且 `audioReady === true`」的词（顺序学习，非随机）
- **复习**：`user_words` 中 `status != mastered` 且 `nextReviewDate <= 今天` 的词，全部答对才解锁新词
- **题型**：中选项（英 → 4 个中文释义）/ 英选中（中 → 4 个英文单词）1:1 交替，干扰项随机取自词库
- **打卡**：`practiceQueue` 全对后 `finish_checkin` 推进 `streak` 与 `wordCursor`
- **发音**：离线音频为主音源（`audio_cache` 命中 → fileID → 前端 `wx.storage` 缓存）；
  单词保留有道 `dictvoice` 兜底，但 `audioReady` 保证学习流程里的词都有音频，实际不会触发；
  例句**无兜底**，未预置时静默不播（补音频是渐进的，弹提示会持续打扰学习）

## 项目结构

<details>
<summary>展开：目录树与 scripts/ 全清单</summary>

```
ielts-vocab/
├── project.config.json      # 项目配置（需填 appid）
├── README.md / LICENSE / CONTRIBUTING.md / .env.example
├── docs/                    # 部署步骤 / 业务逻辑 / 隐私指引 / 简介文案
├── design/                  # 原型与视觉规范（不进小程序包）
│   ├── prototype.html       #   8 页可交互原型（浏览器直接打开）
│   └── tokens.html          #   颜色 / 字号 / 热区规范
├── assets/
│   ├── brand/               # 品牌素材（头像、图标源文件；不进小程序包）
│   ├── word_lists/          # 词表（ECDICT 抽取结果 + 其 MIT 许可证副本）+ pilot-100
│   └── examples/            # 离线生成的例句 JSON（词表级资产，随仓库保留）
├── scripts/                 # 离线工具链（不进小程序包、不进云函数）
│   ├── build_wordlist.py        # 从 ECDICT 抽核心词表（专名剔除 + 名词复数归一）
│   ├── gen_audio.py             # Kokoro 本地合成「单词」发音（默认只做美音）
│   ├── gen_examples.py          # DeepSeek 离线生成例句（含 roots / etymology）
│   ├── gen_sentence_audio.py    # Kokoro 本地合成「例句」发音
│   ├── make_audition_page.py    # 本地预检 + 生成音频试听页
│   ├── pack_audio.py            # 打包成 seed_audio 入参（base64 分批）
│   ├── pack_words.py            # 打包成 seed_words 入参（分词表分批）
│   ├── wxcloud.py               # 云开发 HTTP API 本地客户端（下面几个脚本共用）
│   ├── init_cloud.py            # 本地初始化数据库：建集合 + 建索引
│   ├── seed_cloud.py            # 本地导入全部数据：词表 + 例句富化 + 音频 + audioReady
│   ├── quotes_to_examples.py    # 「每日一句」quotes.js → 可合成的例句 JSON
│   ├── seed_quote_audio.py      # 「每日一句」音频上传 + 写 audio_cache（幂等）
│   ├── fill_token.py            # 批量把 batch-*.json 的占位符换成真实密钥
│   ├── deploy_functions.py      # 一键部署云函数（走开发者工具 CLI，支持只传改动过的）
│   ├── gen_tab_icons.py         # 生成原生 tabBar 图标（纯 Python 光栅化）
│   ├── install_spacy_model.py   # 装 en_core_web_sm（不在 PyPI，走 HF 镜像）
│   ├── check_miniprogram.js     # 小程序结构自检（类名 / 底栏 / 图标 / wxml 配对 / 云函数三件套）
│   └── test_*.js                # 回归脚本 8 支（页面 / 云函数 / mock / 原型）
├── miniprogram/             # 小程序前端
│   ├── app.js / app.json / app.wxss
│   ├── config.js            # 需填云环境 ENV_ID
│   ├── utils/               # api.js（云函数封装）/ audio.js（发音）/ share.js
│   └── pages/               # index / onboarding / learn / practice /
│                            # checkin / stats / wrongbook / profile
└── cloudfunctions/          # 18 个云函数
```

`.env`、`build/`（本地生成的音频与打包产物）、`.workbuddy/` 均不入库。

</details>

## FAQ

**为什么叫「雅词本」，而不是带「雅思」的名字？**
「雅思」是他人注册商标。本项目产品内外统一用「雅词本 / 核心词」，
`grep -rn "雅思" miniprogram/` 必须 0 命中 —— 这条红线对二次开发同样适用。

**必须用 DeepSeek 吗？换个模型行不行？**
换得动。`enrich_word` 只读 `process.env.DEEPSEEK_API_KEY`，走的是 OpenAI 兼容的
`chat/completions` 形态，改成其他供应商只需换环境变量与少量响应解析。
**不配 Key 也能跑**——单词卡会降级只显示词表基础字段。

**必须自己生成音频吗？能不能跳过？**
跳过就没有词可出（出词以 `audioReady` 为闸门）。最小路径是先只跑仓库自带的
`pilot-100`（100 词），闭环即可完整跑通；之后按 `seq` 顺序**增量**补齐，
已有的会自动跳过。

**词表一定要用 ECDICT 吗？**
不一定。任何能提供「单词 / 释义 / 顺序」的表都可以走 `seed_words` 导入。
`build_wordlist.py` 只是从 ECDICT 的 `ielts` 标签抽取，并做**专名剔除**（`york` 这类
因语料频次极高会被排到第 48 位）与**名词复数归一**（3036 → 2987）。

**免费额度够用吗？**
云开发按量计费、有免费额度，本项目在架构上**刻意少调云函数**（音频命中走前端本地缓存、
题目答案不下发以省一次往返）。但实际用量取决于活跃用户数，**上线前请按官方当前计费自行测算**。

**真机能跑吗？音频有什么坑？**
能跑。已知一个坑：`cloud://` 的 fileID 直接塞进 `InnerAudioContext.src`，
真机会**播几秒就断**（第二次才完整）。`utils/audio.js` 已统一转临时链接
（`getTempFileURL` + 内存缓存，失败降级回 fileID），回归见 `scripts/test_audio.js`。

**为什么不用组件库（Vant 等）？**
有意为之：原生 + 一套自持 token（见 `design/tokens.html`），主包体积 **164 KB**。

**可以商用吗？**
MIT 许可**可商用**。但要注意：「雅词本」名称与 `assets/brand/` 图标**不含商标授权**；
词表来自 ECDICT（MIT）、音频由 Kokoro-82M（Apache-2.0）生成，均可商用。
上线仍需自行完成 ICP 备案与选择服务类目。完整边界见[开源许可与声明](#开源许可与声明)。

## 路线图

- [ ] **补真机截图与演示 GIF**（当前唯一的一手体验是 `design/prototype.html`）
- [ ] 错题本「再练一遍」（后端 `round` 通道已就绪）
- [ ] 复习调度升级为完整遗忘曲线（当前为简化版，已预留升级位）
- [ ] 打卡日历可点、错词按出错次数分层
- [ ] 按 `seq` 增量点亮全量 2987 词的音频

已知边界与上线前待办另见 [docs/project-spec.md](docs/project-spec.md) §9。

## 参与贡献

见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。核心提醒：改完请跑
`node scripts/check_miniprogram.js` 与对应的 `scripts/test_*.js`；
新增断言**必须做负向验证**（故意改坏看是否 FAIL），否则容易写出「永远为绿」的假断言。

如果这套架构对你有帮助，欢迎 Star 或提 Issue 告诉我你想抄哪一块。

---

## 开源许可与声明

本项目以 **MIT License** 开源，详见 [LICENSE](./LICENSE)。可自由使用、修改、分发、商用，只需保留版权声明。

### 需要你自行确认的部分

| 项 | 说明 |
|---|---|
| **品牌** | 「雅词本」名称与 `assets/brand/` 下的头像/图标为作者品牌资产，MIT 许可**不含商标授权**。二次开发请更换名称与图标。（`assets/` 在 `miniprogramRoot` 之外，不会打进小程序包） |
| **词表** | 由 `scripts/build_wordlist.py` 从 **ECDICT（MIT License, Copyright (c) 2025 Linwei）** 抽取，可商用，需保留版权声明；许可证副本见 `assets/word_lists/ECDICT-LICENSE.txt` |
| **发音音频** | 由 **Kokoro-82M（Apache-2.0）** 本地生成，可自由商用。改用其他引擎前请先确认其对生成音频的授权——XTTS v2 / F5-TTS 的权重为非商用许可，`edge-tts` 属非官方客户端（与 `dictvoice` 同一灰色性质） |
| **兜底发音接口** | 代码示例保留了有道 `dictvoice` 作为词表外兜底，该接口并非有道对第三方开放的商用接口。商用请替换为合规 TTS 服务 |
| **AI 内容** | 例句 / 词根 / 词源由 DeepSeek 生成，需遵循其服务条款，API Key 自行申请配置 |
| **合规** | 上线需自行完成 ICP 备案、选择服务类目，并遵守《微信小程序平台运营规范》 |

### 安全部署要点

- **云函数是对全体小程序用户开放的接口**：函数名藏不住、入参可伪造。管理 / 花钱 / 写库类能力务必自带校验——本项目已在 `enrich_word`（`force` 需管理员）、`seed_words` / `seed_audio` / `reset_words` / `init_db`（强制管理员密钥）、`audio_cache`（入参正则收敛）上做了加固。
- **密钥只放云函数环境变量**：DeepSeek Key、`ADMIN_TOKEN` 都不得写进代码或 `miniprogram/` 下的任何文件（前端包体可被反编译）。
- **`AppSecret` 绝不入库**：云环境 ID 与小程序 AppID 属公开信息，`AppSecret` 才是能签发调用凭证的密钥。

---

## 注意事项（fork 前自检）

- [ ] **fork 后必须替换** `project.config.json` 的 `appid` 与 `miniprogram/config.js` 的 `ENV_ID`（二者非密钥，但用作者的会连到作者的云环境）
- [ ] **品牌与提审文案同样要换**：「雅词本」名称与 `assets/brand/` 图标属作者品牌资产（MIT **不含商标授权**）；`docs/intro.md` / `docs/隐私保护指引.md` 是示例文案，发布前替换为你自己的产品名与主体信息
- [ ] `enrich_word` 必须配 `DEEPSEEK_API_KEY`（且账户有余额），否则单词卡只显示词表基础字段
- [ ] 数据初始化走本地脚本，都幂等可重复跑：`python scripts/init_cloud.py --apply`（集合 + 索引）→ `python scripts/seed_cloud.py --apply --reset`（词表 + 音频 + audioReady）
- [ ] **集合权限只能手工配一次**（HTTP API 没有权限接口）：`words` = 所有用户可读 / 仅管理端可写，其余 = 仅创建者可读写
- [ ] `ADMIN_TOKEN` 只在你想走**控制台路径**时才需要配（本地脚本路径不需要）；要在对应云函数上**分别配置**同一个值
- [ ] 云开发控制台 → 设置 → **「未登录访问」保持关闭**（开启后任何持有环境 ID 的人都能访问你的云资源）
- [ ] `scripts/fill_token.py` 填过密钥的 `batch-*.json` 含明文密钥，位于 `build/`（已 gitignore），**勿提交、勿外移**
- [ ] 小程序发布前需完成 **ICP 备案**
- [ ] 音频许可：用 **Kokoro-82M（Apache-2.0）**；不要换成系统 `say` / `edge-tts` 等受限或灰色音源
