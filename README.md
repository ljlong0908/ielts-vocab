# 雅词本 · 雅思词汇微信小程序

帮助雅思考生用每天的碎片时间积累核心词汇。核心闭环：

**微信登录 → 设置每日目标 → 复习昨日单词 → 学今日新词 → 做题检验 → 全对打卡 → 次日循环**

技术底座：**微信云开发 CloudBase**（云函数 + 云数据库 + 云存储），无需自建服务器。**个人主体可用**——不依赖同声传译插件，发音全部自持。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| **[docs/deploy.md](docs/deploy.md)** | **部署与上线步骤 —— 唯一权威操作清单**，从零到可用，含验收表 / 报错排查 / 提审检查 |
| [docs/project-spec.md](docs/project-spec.md) | 项目结构与业务逻辑说明（**以源码为准**，供 AI 作为上下文） |
| [docs/隐私保护指引.md](docs/隐私保护指引.md) | 隐私合规文案（提审用） |
| [docs/intro.md](docs/intro.md) | 小程序简介文案（市场介绍 / 分享文案） |

> 上手看本文件，动手部署直接翻 `docs/deploy.md`。

---

## 目录结构

```
ielts-vocab/
├── project.config.json      # 项目配置（需填 appid）
├── README.md / LICENSE
├── docs/                    # 部署步骤 / 业务逻辑 / 隐私指引 / 简介文案
├── assets/
│   ├── brand/               # 品牌素材（头像、图标源文件；不进小程序包）
│   ├── word_lists/          # 词表（ECDICT 抽取结果 + 其 MIT 许可证副本）
│   └── examples/            # 离线生成的例句 JSON（词表级资产，随仓库保留）
├── scripts/                 # 离线工具链（不进小程序包、不进云函数）
│   ├── build_wordlist.py        # 从 ECDICT 抽雅思词表（专名剔除 + 名词复数归一）
│   ├── gen_audio.py             # Kokoro 本地合成「单词」发音（默认只做美音）
│   ├── gen_examples.py          # DeepSeek 离线生成例句（含 roots / etymology）
│   ├── gen_sentence_audio.py    # Kokoro 本地合成「例句」发音
│   ├── make_audition_page.py    # 本地预检 + 生成音频试听页
│   ├── pack_audio.py            # 打包成 seed_audio 入参（base64 分批）
│   ├── pack_words.py            # 打包成 seed_words 入参（分词表分批）
│   ├── init_cloud.py            # 本地初始化数据库：建集合 + 建索引（云开发 HTTP API）
│   ├── fill_token.py            # 批量把 batch-*.json 的占位符换成真实密钥
│   └── install_spacy_model.py   # 装 en_core_web_sm（不在 PyPI，走 HF 镜像）
├── miniprogram/             # 小程序前端
│   ├── app.js / app.json / app.wxss
│   ├── config.js            # 需填云环境 ENV_ID
│   ├── utils/               # api.js（云函数封装）/ audio.js（发音）/ share.js
│   └── pages/               # index / onboarding / learn / practice /
│                            # checkin / stats / wrongbook / profile
└── cloudfunctions/          # 15 个云函数
```

---

## 快速开始

完整步骤见 **[docs/deploy.md](docs/deploy.md)**，这里是骨架：

1. **导入项目** —— 开发者工具选**仓库根**（含 `project.config.json`），填入自己的 AppID
2. **开通云开发** —— 复制环境 ID，填进 `miniprogram/config.js` 的 `ENV_ID`
3. **配环境变量** —— `ADMIN_TOKEN`（5 个函数各配一遍）+ `DEEPSEEK_API_KEY`（只配 `enrich_word`）。**环境变量是函数级隔离的，最容易漏**
4. **部署云函数** —— 15 个目录逐个「上传并部署：云端安装依赖」
5. **初始化数据表** —— 控制台跑 `init_db`：`preview` → `create`，再按返回的清单手工建 10 条索引
6. **导入词表与音频** —— 控制台跑 `seed_words` / `seed_audio`（音频先在本地生成、打包）
7. **编译预览**

---

## 云函数清单（15 个）

每个函数都有自己的 `config.json` 声明超时，不依赖控制台默认值。

**前端调用（10）**

| 函数 | 作用 | 超时 |
|---|---|---|
| `user_profile` | 登录 + 每日目标 | 20s |
| `home_summary` | 首页聚合数据 | 20s |
| `today_flow` | 当日流程状态机（前端唯一状态来源） | 20s |
| `start_new_words` | 幂等生成当日新词队列 | 20s |
| `word_card` | 单词卡（触发 AI 补全） | 30s |
| `build_questions` | 生成题目（**答案留在服务端**） | 30s |
| `submit_answer` | 服务端判题 + 推进复习池 | 20s |
| `finish_checkin` | 打卡（幂等） | 30s |
| `stats` | 统计与错题数据 | 30s |
| `audio_cache` | 音频读缓存（命中直接返回 fileID） | 20s |

**服务端 / 管理调用（5）**

| 函数 | 作用 | 调用方 | 超时 |
|---|---|---|---|
| `enrich_word` | AI 内容补全（带乐观锁 + 缓存 + 定时重试） | `word_card` 服务端调 + 定时器 | 30s |
| `seed_words` | 词表导入（幂等，永不覆盖） | 控制台 | 60s |
| `seed_audio` | 音频入库 + 点亮 `audioReady` | 控制台 | 60s |
| `reset_words` | 词库重置（破坏性，需二次确认） | 控制台 | 60s |
| `init_db` | 数据表初始化 / 体检（幂等） | 控制台 | 60s |

数据库集合：`users` / `words` / `user_words` / `daily_plans` / `records` / `checkins` / `audio_cache`。

---

## 核心机制

### 出词策略：`audioReady` 是一道闸门

按 `words.seq` 升序取「`seq > wordCursor` 且 `audioReady === true`」的词。**只有音频已就绪的词才进学习流程**，所以可以先导入全量词表、再分批「点亮」音频。

> 由此推出两条硬约束：① `wordCursor` **必须按 seq 取值推进**（打卡时取当日已学词的最大 seq），不能按词数累加，否则过滤后会错位重复出词；② **音频要按 `seq` 从前往后连续生成**。

### AI 内容生成与缓存（降本关键）

单词的**例句 / 词根拆解 / 词源演变**缺失时，由 `word_card` → `enrich_word` 调 **DeepSeek** 生成：

1. `words.enriched = true` → 直接读库，**绝不调模型**
2. 未生成 → **乐观锁** `enrichStatus: pending → generating`，保证同一单词全局只生成一次
3. 生成 → 内容安全检测（`msgSecCheck`）→ 写回并置 `enriched = true`
4. 失败 → 降级返回词表基础字段，标记 `failed`，由**定时任务**（每天 03:00）重试并释放超时锁

### 每日闭环状态机

`daily_plans.stage`：`review → learning → practice → practice_done → done`

- **复习**：`user_words` 中 `status != mastered` 且 `nextReviewDate <= 今天` 的词，全部答对才解锁新词
- **打卡**：`practiceQueue` 全部答对后 `finish_checkin` 推进 `streak` 与 `wordCursor`

### 题型

- **中选项**（`cn_option`）：英文单词 → 4 个中文释义
- **英选中**（`en_option`）：中文释义 → 4 个英文单词
- 两种题型 1:1 交替；干扰项随机取自词库
- 判题在**服务端**（`submit_answer`），下发的题目不含答案

### 发音：全部自持，运行时不外呼

主音源是**云存储里的离线音频**，不依赖任何第三方 TTS 接口：

1. **预生成**：本地用 Kokoro-82M 批量合成（当前只做美音 type=2）
2. **云存储 + `audio_cache` 集合**（跨用户共享）→ 命中即返回 fileID，**全局零外呼**
3. **前端 wx.storage 缓存 fileID** → 秒播，连云函数都不调

例句发音走同一套链路（以整句文本为 key）。与单词不同，例句**没有兜底**——未预置音频时静默不播（补音频是渐进的，弹提示会持续打扰学习）。

> 单词仍保留有道 `dictvoice` 兜底，仅用于词表外的词；`audioReady` 机制保证学习流程里出现的词都有音频，所以这条兜底实际不会触发。全量音频就绪后，可删掉 `downloadFile` 合法域名 `https://dict.youdao.com`，彻底摆脱第三方的版权灰区与限流风险。
>
> 更早的历史方案是微信同声传译插件（WechatSI），该插件仅对企业主体开放，已废弃。

### 离线音频流水线（本地生成，云端只存储）

**音频 100% 在本地生成，云端不做任何合成。** 完整命令与实测数据见 [`docs/project-spec.md`](docs/project-spec.md) §7 与 [`docs/deploy.md`](docs/deploy.md) §7。

- **单词**：`build_wordlist.py` → `gen_audio.py` → `make_audition_page.py`（预检/试听）→ `pack_audio.py` → 控制台 `seed_audio`
- **例句**：`gen_examples.py` → `gen_sentence_audio.py` → `make_audition_page.py` → `pack_audio.py` → 控制台 `seed_audio`

---

## 注意事项

- [ ] **fork 后必须替换** `project.config.json` 的 `appid` 与 `miniprogram/config.js` 的 `ENV_ID`（二者非密钥，但用作者的会连到作者的云环境）
- [ ] `enrich_word` 必须配 `DEEPSEEK_API_KEY`（且账户有余额），否则单词卡只显示词表基础字段
- [ ] `ADMIN_TOKEN` 要在 **5 个函数**（`enrich_word`/`seed_words`/`seed_audio`/`reset_words`/`init_db`）上**分别配置**同一个值
- [ ] 云开发控制台 → 设置 → **「未登录访问」保持关闭**（开启后任何持有环境 ID 的人都能访问你的云资源）
- [ ] 数据表用 `init_db` 一键创建（幂等）；**索引与安全规则必须手工配**（SDK 建不了）
- [ ] `scripts/fill_token.py` 填过密钥的 `batch-*.json` 含明文密钥，位于 `build/`（已 gitignore），**勿提交、勿外移**
- [ ] 小程序发布前需完成 **ICP 备案**
- [ ] 音频许可：用 **Kokoro-82M（Apache-2.0）**；不要换成系统 `say` / `edge-tts` 等受限或灰色音源

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
