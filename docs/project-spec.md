# 雅词本 — 项目结构与业务逻辑说明

> **文档用途**：供 AI 或其他协作者快速理解本项目的**目录结构**与**业务逻辑**，作为上下文注入。
> **权威性**：本文档以**源码为准**（`miniprogram/` + `cloudfunctions/`）。设计阶段的历史稿（曾提到 Vant / 微信同声传译插件，均未采用）已于 2026-09-28 清理，**以本文档为准**。
> **最后核对**：2026-09-30（第一版封版 `v1.0`）。阅读顺序：**§1–§10 = 现状**（改需求看 §10 索引）；**§11 = UX 优化轮的施工与决策留档**（M/T 清单的最终结论，原始施工单已合并至此）；**§12 = 历代整理记录**（考古用，日常不必读）。

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 产品名 | 雅词本（工程代号 `ielts-vocab`） |
| 形态 | 微信小程序（原生，非 uni-app/Taro） |
| 定位 | 核心词汇**每日学习闭环**工具（词表取自 ECDICT 的 `ielts` 标签；产品文案一律「雅词本 / 核心词」，见 §8 命名红线） |
| 核心闭环 | 微信静默登录 → 设每日目标(5/10) → **先复习旧词** → 学今日新词 → 做题 → **全对才打卡** → 次日循环 |
| 后端 | 微信云开发 CloudBase（**18 个云函数** + 7 个文档型集合 + 云存储），无自建服务器 |
| AI 能力 | DeepSeek（`deepseek-chat`）生成例句 / 词根拆解 / 词源演变 |
| 发音 | **本地 Kokoro-82M（Apache-2.0）离线预生成 → 云存储**，运行时零 TTS 外呼；dictvoice 仅作词表外单词兜底 |
| 部署 | 见 `docs/deploy.md`（从零到可用的唯一权威清单） |

**一句话业务本质**：每天先清「复习债」（昨日及所有到期的未掌握词，全对才解锁新词），再学当日新词，做完题全答对才能打卡；次日待复习的单词 = 昨天新学的单词。

---

## 2. 技术栈与架构

```
┌──────────────────────────────────────────────┐
│ 小程序端 (miniprogram/)                        │
│   页面层 WXML/WXSS  +  逻辑层 JS               │
│   utils/api.js  →  wx.cloud.callFunction       │
│   utils/audio.js →  三层缓存 + InnerAudioContext│
│   无第三方 UI 库（design 提过 Vant，未引入）    │
└───────────────────────┬──────────────────────┘
                        │ callFunction / 云存储 fileID
┌───────────────────────▼──────────────────────┐
│ 微信云开发 CloudBase                           │
│   云函数 (cloudfunctions/, Node.js)            │
│   云数据库（文档型，7 个集合）                  │
│   云存储（音频 audio/{type}/{slug}.mp3、s_{hash}.mp3）│
└───────┬───────────────────────┬───────────────┘
        │ HTTPS                 │ openapi
┌───────▼──────────┐   ┌────────▼──────────────┐
│ DeepSeek API      │   │ security.msgSecCheck  │
│ api.deepseek.com  │   │ 内容安全（AI 内容入库前）│
└───────────────────┘   └───────────────────────┘
        ▲
        │ HTTPS（**仅词表外单词兜底**；主音源是云存储里的本地预生成音频）
┌───────┴──────────┐
│ 有道 dictvoice    │
│ dict.youdao.com   │
└───────────────────┘
```

**分层职责**：
- **前端**：只做渲染、交互、云函数调用、音频播放；不持有任何密钥；不直接写数据库。**唯一例外的判断**是选择题对错（答案随题下发，本地比对即可 —— 见 §7.5），但记录与状态推进仍全部走云函数。
- **云函数**：所有写操作、AI 调用、内容安全、并发锁都在服务端完成；选择题的**判题结果**虽由前端先得出，服务端在落库时仍会自判一次（不信客户端）。
- **云数据库**：业务数据存储 + **AI 生成内容缓存**（`words.enriched`）。
- **云存储**：音频缓存（跨用户共享）。

---

## 3. 目录结构（文件级）

```
ielts-vocab/
├── project.config.json           # 开发者工具项目配置（含 appid、miniprogramRoot、cloudfunctionRoot）
├── project.private.config.json   # 开发者工具私有配置（不入库）
├── .gitignore                    # 忽略 node_modules / 私有配置 / .env / build 等
├── LICENSE                       # MIT
├── README.md                     # 上手概览（细节指向 docs/）
├── docs/
│   ├── deploy.md                 # ★ 部署与上线步骤（从零到可用）
│   ├── intro.md                  # 小程序简介（含 ≤120 字后台版本）
│   ├── 隐私保护指引.md            # 隐私合规文案
│   └── project-spec.md           # ★ 本文档
├── assets/
│   ├── brand/                    # 品牌素材（头像 / 图标源文件；在 miniprogramRoot 之外，不进小程序包）
│   ├── word_lists/               # 词表源文件（ECDICT 抽取结果 + 其 MIT 许可证副本）
│   └── examples/                 # 离线生成的例句 JSON（词表级资产，随仓库保留）
├── scripts/                      # ★ 离线工具链（不进小程序包、不进云函数）
│   ├── build_wordlist.py         # 从 ECDICT 抽核心词表（`ielts` 标签）→ assets/word_lists/*.json
│   ├── gen_audio.py              # Kokoro 合成**单词**发音（默认只做美音）→ build/audio/us/*.mp3
│   ├── gen_examples.py           # DeepSeek 离线生成例句 → assets/examples/*-examples.json
│   ├── gen_sentence_audio.py     # Kokoro 合成**例句**发音 → build/sentence_audio/us/s_{hash}.mp3
│   ├── install_spacy_model.py    # 装 en_core_web_sm（不在 PyPI，走 HF 镜像）
│   ├── make_audition_page.py     # 本地预检 + 生成音频试听页（单词/例句通用）→ build/audition*.html
│   ├── pack_audio.py             # 打包成 seed_audio 的入参（分批 base64，单词/例句通用）
│   ├── pack_words.py             # 打包成 seed_words 的入参（按词表分批，每批一份完整入参）
│   ├── init_cloud.py             # 本地初始化数据库：建集合 + 建索引（走云开发 HTTP API）
│   ├── fill_token.py             # 批量把 batch-*.json 的 __ADMIN_TOKEN__ 换成真实密钥
│   ├── quotes_to_examples.py     # 「每日一句」quotes.js → assets/examples/quotes-12.json（供音频合成）
│   ├── seed_quote_audio.py       # 「每日一句」音频上传云存储 + 写 audio_cache（走 HTTP API，幂等）
│   ├── gen_similar.py            # 离线计算词表「形似词」（编辑距离）→ assets/word_lists/ielts-full-similar.json
│   ├── seed_similar.py           # 把形似词写入云端 words.similar（走 HTTP API，幂等，默认 dry-run）
│   └── requirements.txt
├── miniprogram/                  # 小程序前端根（miniprogramRoot）
│   ├── app.js                    # 启动：仅 wx.cloud.init（不缓存用户态，由各页面按需拉取）
│   ├── app.json                  # 页面注册、窗口样式（无插件声明）
│   ├── app.wxss                  # 全局样式
│   ├── config.js                 # ENV_ID / DAILY_GOAL_OPTIONS / TTS_LANG / 云函数名常量 FN
│   ├── sitemap.json
│   ├── utils/
│   │   ├── api.js                # 云函数调用统一封装（约定 {code,data,message}）+ 各接口快捷方法
│   │   ├── audio.js              # 发音：三层缓存 + 整句播放（单词/例句共用 playSrc）
│   │   └── share.js              # 分享转发统一配置（toFriend()，路径统一回首页）
│   └── pages/
│       ├── index/                # 首页：今日进度、streak、入口；首次未 onboarded → 跳 onboarding
│       ├── onboarding/           # 首次设置每日目标 5/10
│       ├── learn/                # 单词卡逐张学习（单词 + 例句发音均已启用，见 7.9）
│       ├── practice/             # 练习（review / practice 两阶段共用）
│       ├── checkin/              # 打卡结果页（进入即调 finishCheckin）
│       ├── stats/                # 统计 + 打卡日历
│       ├── wrongbook/            # 错题本
│       └── profile/              # 我的 / 目标设置 / 入口
└── cloudfunctions/               # 云函数根（cloudfunctionRoot）
    ├── user_profile/             # 登录 + 设置目标
    ├── home_summary/             # 首页聚合
    ├── today_flow/               # 当日流程状态编排（前端唯一状态来源）
    ├── start_new_words/          # 幂等生成当日新词队列（只取 audioReady=true 的词）
    ├── word_card/                # 单词卡（触发 AI 补全 + 返回缓存）
    ├── build_questions/          # 生成双向题型题目（答案随题下发，供前端本地判题）
    ├── submit_answer/            # 后台落库（答题记录）+ 复习推进
    ├── finish_checkin/           # 打卡（幂等）+ 注册复习池（wordCursor 按 seq 推进）
    ├── stats/                    # 统计 + 错题
    ├── audio_cache/              # 音频读缓存：查 audio_cache 集合命中即返回 fileID
    ├── enrich_word/              # AI 内容补全（乐观锁 + 定时重试）
    ├── seed_words/               # 词表导入（管理用，按 word 去重跳过、seq 续号）
    ├── seed_audio/               # 音频入库：上传云存储 + 写索引 + 点亮 audioReady（管理用）
    ├── reset_words/              # 词库重置（管理用，⚠️ 破坏性，带 preview 预检 + confirm 二次确认）
    └── init_db/                  # ★ 数据表体检 / 初始化（管理用，幂等；顺带返回手工索引清单）
```

---

## 4. 数据模型（云数据库集合，共 7 个）

> 云开发文档型数据库（类 MongoDB）。所有集合字段如下为**代码实际写入**的字段。
> 集合与索引的**权威清单**在 `assets/db-indexes.json`（`scripts/init_cloud.py` 读它做本地一键初始化）。
> 建表 / 建索引 / 安全规则的完整说明见 `docs/deploy.md` 第 5 节（也可走控制台 `init_db` 云函数建集合并取回索引清单）。

### 4.1 `users` — 用户
| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` | string | 微信用户唯一标识（逻辑主键，建议唯一索引） |
| ~~`nickname` / `avatarUrl`~~ | — | **不收集**（未接入微信头像/昵称授权，前端不调 `getUserProfile`，源码中已注释）。如后续新增个人主页功能再恢复 |
| `dailyGoal` | number | 每日新词数，`5` 或 `10`，默认 5 |
| `streak` | number | 连续打卡天数 |
| `lastCheckinDate` | string | 最近打卡日 `YYYY-MM-DD` |
| `totalLearned` | number | 累计学习词数 |
| `wordCursor` | number | **出词游标**：已学到的最大 `words.seq`。打卡时取当日已学词的最大 seq 写入（**不是**按词数累加——出词条件带 `audioReady` 过滤后词可能不连续，按数量累加会错位并重复出词） |
| `createdAt` / `updatedAt` | date | 时间戳 |

### 4.2 `words` — 词库 + AI 缓存（关键表）
| 字段 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `word` | string | 词表 | 单词，唯一 |
| `phoneticUK` / `phoneticUS` | string | 词表 | 英/美音标 |
| `pos` | string | 词表 | 词性 |
| `meaning` | string | 词表 | 中文释义 |
| `seq` | number | 系统 | **顺序出词序号**，导入时自动续号 |
| `audioReady` | boolean | 系统 | **发音音频是否就绪**。导入时默认 `false`，由 `seed_audio` 上传音频后置 `true`。`start_new_words` 只取 `audioReady === true` 的词，故**没有读音的词不会进入学习流程** |
| `audioReadyAt` | date | 系统 | 音频就绪时间 |
| `level` | number | 词表 | 难度，默认 1 |
| `source` | string | 词表 | 来源标记，默认 `seed` |
| `example` | object\|null | **AI** | `{ en, cn }` 例句 |
| `roots` | array | **AI** | `[{ part, type, meaning }]`，type ∈ prefix/root/suffix |
| `etymology` | string | **AI** | 词源演变简述 |
| `similar` | array | **脚本** | `[{ word, phonetic, meaning }]` **形似词**（最多 3 条，按相似度降序）。由 `scripts/gen_similar.py` 离线编辑距离计算、`scripts/seed_similar.py` 播种；`word_card` 随整 doc 透传，学习页展示 + 点喇叭发音。详见 §11.11 |
| `enriched` | boolean | 系统 | 扩展内容是否已补全（**缓存命中判据**） |
| `enrichStatus` | string | 系统 | `pending` / `generating` / `ok` / `failed` |
| `enrichLockAt` | date\|null | 系统 | 抢锁时间，用于超时释放 |
| `enrichedAt` | date | 系统 | 补全完成时间 |
| `enrichError` | string | 系统 | 失败原因（排查用） |
| `createdAt` | date | 系统 | |

### 4.3 `user_words` — 用户单词学习状态（复习调度核心）
| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` / `wordId` | string | 联合唯一 |
| `status` | string | `reviewing`（待复习）/ `mastered`（已掌握） |
| `round` | number | 复习轮次（预留 v2 升级 FSRS） |
| `wrongCount` | number | 累计答错次数 |
| `firstLearnedDate` | string | 首次学习日 |
| `lastReviewDate` | string | 最近复习日 |
| `nextReviewDate` | string | 下次复习日；mastered 时为空字符串 |
| `createdAt` / `updatedAt` | date | |

### 4.4 `daily_plans` — 每日计划（当日状态机载体）
| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` / `date` | string | 联合唯一 |
| `reviewWordIds` | array | 当日待复习词 ID（非 mastered 且 nextReviewDate ≤ 今天） |
| `newWordIds` | array | 当日新词队列 ID |
| `learnedIds` | array | 已完成学习的词 ID（`markLearned` 累加） |
| `reviewQueue` | array | 复习题目（**含答案**，不下发） |
| `practiceQueue` | array | 练习题目（**含答案**，不下发） |
| `stage` | string | `review` / `learning` / `practice` / `practice_done` / `done` |
| `extraRounds` | array | **加练组**（M13/T1）：`[{roundId, wordIds, learnedIds, practiceQueue, stage, startedAt, finishedAt}]`。内嵌不另建文档，绕开 `_openid+date` 唯一索引；读取处一律 `plan.extraRounds \|\| []` 兜底 |
| `createdAt` / `updatedAt` | date | |

### 4.5 `records` — 答题记录
| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` / `wordId` / `date` | string | |
| `phase` | string | `review` / `practice` |
| `questionType` | string | `cn_option` / `en_option` |
| `isCorrect` | boolean | 本次是否答对 |
| `choice` | number | 用户选择的选项下标 |
| `createdAt` | date | |
| `mastered` | boolean | **仅答错记录会有**。用户在错题本点「已掌握」后由 `dismiss_wrong` 置 `true`，`stats` 据此把该词移出错题本。写在记录上（而非独立集合）的两个原因：① 流水保持完整，将来按 `records` 统计正确率不受影响 ② 「复活」零成本——之后再答错写的是新记录（无此字段），自然重新进错题本 |
| `masteredAt` | date | 标记时间，便于回溯 |

> 注意：每次提交（含答错重选）都会新增一条记录。
> ⚠️ `mastered` **不需要回填历史数据**：`stats` 的查询条件是 `mastered: _.neq(true)`，
> 而 MongoDB 的 `$ne` 会一并匹配「字段不存在」的文档。

### 4.6 `checkins` — 打卡记录
| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` / `date` | string | 联合唯一 |
| `streakAtCheckin` | number | 打卡时的连续天数 |
| `learnedCount` | number | 当日学习词数（= newWordIds.length） |
| `createdAt` | date | |

### 4.7 `audio_cache` — 音频缓存索引（跨用户共享）
| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 缓存键：**单词**为词本身（≤40 字符）；**例句**为整句英文（≤200 字符） |
| `type` | number | 1=英音 / 2=美音 |
| `fileID` | string | 云存储文件 ID |
| `kind` | string | `word` / `sentence`，区分音频类型（由 `seed_audio` / `audio_cache` 写入） |
| `source` | string | `preseed`（本地预生成上传） / `dictvoice`（旧兜底路径） |
| `bytes` | number | 音频字节数（预生成路径写入，便于估算存储） |
| `createdAt` / `updatedAt` | date | |

> 建议索引：`audio_cache(text, type)` 唯一。
> ⚠️ 例句同样以 `text` 为键（内容为整句），故该字段可能很长；不要对它做前缀查询。

---

## 5. 云函数契约（共 18 个）

> 统一返回 `{ code: 0, data }` 成功 / `{ code: -1, message }` 失败。前端 `api.js` 依据 `code` 判定。
> 所有函数均 `cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })`，用户身份取自 `cloud.getWXContext().OPENID`（无需前端传）。
>
> ⚠️ **安全前提**：云函数是**对全体小程序用户开放的接口**——任何人都能 `wx.cloud.callFunction({ name, data })` 调用任意函数，且 `data` 可任意伪造，函数名也无法在前端隐藏。因此**不能靠「前端不调用」实现安全**，每个函数都要自己校验入参/权限。当前已加固五处：`enrich_word` 的 `force`，以及 `seed_words` / `seed_audio` / `reset_words` / `init_db` 的管理密钥鉴权；另有 `audio_cache` 的入参正则兜底（见各函数头注释）。

| # | 云函数 | 入参 | 出参（data） | 职责与关键逻辑 |
|---|---|---|---|---|
| 1 | `user_profile` | `{ action?: 'get'\|'setGoal', dailyGoal? }` | 用户对象 | 登录：按 openid 查/建用户；`setGoal` 时写 `dailyGoal`（仅接受 5 或 10） |
| 2 | `home_summary` | `{}` | `{dailyGoal,streak,totalLearned,learnedToday,extraLearnedToday,todayDone}` | 首页聚合。`todayDone` 判据 = 今日 checkins 存在；`extraLearnedToday` = 当日各加练组 `learnedIds` 之和 |
| 3 | `today_flow` | `{}` 或 `{action:'markLearned', wordId, round?}` | `{plan,dailyGoal,streak,totalLearned,extra}` | **前端唯一状态来源**。首次进入创建当日 plan：有待复习→`review`，否则→`learning`；待复习集合 = `status='reviewing'`（**正相匹配**，R6：出池终态 `reviewed` 必须排除，用 `_.neq('mastered')` 会把它捞回来）且 `nextReviewDate ≤ 今天`，按 `nextReviewDate` **升序**取（R4，超 50 条时最老先复习）；若今日已打卡则强制 `stage='done'`（只改内存，不落库）。`markLearned` 轻量累加 `learnedIds`；`round>0` 时改累加**该加练组**的 `learnedIds`。`extra` = `{canStart,exhausted,limitReached,pendingRound,roundsToday,extraLearnedToday,groupSize}`，供首页「再学一组」按钮决策；返回的 `plan.extraRounds` 已剥掉 `practiceQueue`（避免答案下发） |
| 4 | `start_new_words` | `{}` | `{newWordIds,reused,exhausted}` | **幂等**生成当日新词：若 plan 已有 newWordIds 直接复用；否则按 `seq > wordCursor` **且 `audioReady === true`** 的顺序取 `dailyGoal` 个。✅ 没音频的词不会出（见 7.3） |
| 5 | `word_card` | `{ wordId }` | 单词卡文档 + `enriching` | 读词；`enriched=false` 时**同步调用** `enrich_word` 再读一次；仍失败则返回基础字段 + `enriching:true` |
| 6 | `build_questions` | `{ phase:'review'\|'practice', round? }` | `{questions,reused}` | 生成题目（**先查缓存复用**）。`round>0` 时读写 `extraRounds[round-1].practiceQueue`、词源取该组 `wordIds`（**C4**：不加 round 会覆盖 `plan.practiceQueue`）。题型 `i%2` 交替 cn_option/en_option，再 shuffle；干扰项从**非本批**词库随机取 3 个。**答案随题下发**：每题带 `answerIndex` + `audioText`（`toClient()`，前端据此本地判题，见 7.5） |
| 7 | `submit_answer` | `{ phase, questionIndex, choice, round? }` | `{correct,answerIndex,wordId,word,meaning,phaseDone}` | **降级为「后台落库」**：前端已本地判过对错，这里仍服务端判一次（不信前端）+ 写 `records` + 推进 `user_words` 复习状态 + `round===0` 全对推进 `plan.stage` / `round>0` 只更新组内队列与组 `stage`（**C3**：绝不写 `plan.stage`）。返回值前端主路径已不依赖。⚠️ **R2**：practice/加练阶段答错且 `user_words` 无该词记录时，落一条只带 `wrongCount:1` 的记录（不写调度字段 → 没打卡不进次日复习集合），让次日 clean 判定看得见昨天练习答的错。⚠️ **R6**：`user_words` 推进是**出池语义** —— review 阶段答对 clean → `mastered`；否则（本轮答错/历史有错/答错）→ `reviewed` + `nextReviewDate=''`，**任何阶段答错都不再写「次日报到」**（错词次日不再自动复习，出路是错题本「已掌握」） |
| 8 | `finish_checkin` | `{}` | `{already,streak,learnedCount,totalLearned}` | **幂等**打卡。前置：practiceQueue 全部 passed。写 `checkins`、更新 `streak`/`totalLearned`、**`wordCursor` 取当日已学词的最大 `seq`**（`words.where({_id: _.in(newWordIds)}).orderBy('seq','desc')`）、新词入复习池（`nextReviewDate=次日`）、`stage='done'` |
| 9 | `stats` | `{}` | `{streak,totalLearned,dailyGoal,totalCheckins,dates[],wrongWords[]}` | 打卡日历日期列表 + 错题（`records.isCorrect=false` **且未被标 `mastered`** 去重取最近 50）+ 词条 |
| 10 | `audio_cache` | `{ text, type, kind? }` | `{fileID,cached}` | **两类文本两种策略**。① 单词（`kind` 缺省）：查 `audio_cache` 命中直接返回；未命中下载 dictvoice → 上传云存储 → 写索引 → 返回 fileID。② 例句（`kind:'sentence'`）：**只查库，未命中直接返回 `NOT_PRESEEDED`，不调第三方也不写云存储**（整句 dictvoice 必返回 null；且在此开放「下载+写存储」等于给任意长文本开滥用口子）。**入参校验**：单词 `^[A-Za-z][A-Za-z'\u2019\- ]{0,39}$`（≤40 字符）、例句 `^[A-Za-z][^\x00-\x1F\x7F\\`]{0,199}$`（≤200 字符，**排除集**写法，见 7.8），`type` 收敛为 1/2 |
| 11 | `enrich_word` | `{ wordId, force?, _token? }` 或定时事件 `{Type:'Timer'}` | `{enriched}` / `{locked}` / `{skipped}` | AI 补全：乐观锁 `pending→generating`，调 DeepSeek（JSON Output），`msgSecCheck` 后写回 `enriched=true`。定时任务释放超时锁 + 批量重试。**鉴权**：`force` 仅在 `_token === ADMIN_TOKEN` 时生效，否则忽略（防绕过缓存无限烧余额） |
| 12 | `seed_words` | `{ _token, words[], offset?, limit?, startSeq? }` | `{inserted,skipped,total,nextOffset,hasMore,lastSeq}` | 词表导入。`seq` 自动续号、按 `word` 去重、支持分批。写入时 `audioReady: false`。**鉴权**：必须携带 `_token === ADMIN_TOKEN`；未配 `ADMIN_TOKEN` 时拒绝一切调用 |
| 13 | `seed_audio` | `{ _token, items: [{ word \| kind:'sentence'+text, type, base64 }] }` | `{received,uploaded,cached,updated,marked,sentences,notInWords?,failed?}` | **音频入库**（一次调用做几件事）：① `uploadFile` 到云存储（单词 `audio/{type}/{slug}.mp3`，例句 `audio/{type}/s_{hash}.mp3`）；② upsert `audio_cache`（以文本+type 为键，存在则更新 fileID）；③ **仅单词**把 `words` 中同名词的 `audioReady` 置 `true`（分批 50 条，`where({word: _.in(chunk), audioReady: _.neq(true)})`）——例句不参与出词，故不点亮。单次 ≤80 条 / 单条 base64 ≤600KB。**鉴权**：同 `seed_words`。配套脚本：单词 `gen_audio.py`、例句 `gen_examples.py`+`gen_sentence_audio.py`，统一由 `pack_audio.py` 打包 |
| 14 | `reset_words` | `{ _token, mode?: 'preview'\|'purge', confirm?, collections?, resetCursor?, resetStats? }` | `preview`：`{mode,before,wouldPurge,keptByDefault}`；`purge`：`{targets,removed,cursorReset,before,after,errors?}` | **词库重置（破坏性）**。用于「换词表、推倒重来」。默认清 `words` + `user_words` + `records` + `daily_plans`（后三者按 `wordId` 引用 `words._id`），并把 `users.wordCursor` 归零（否则新词从 seq 1 开始会被旧游标跳过）。**保留** `audio_cache`（按 `text` 建索引，重导可复用）与 `checkins`（不含词引用）。分批 100 条删除。**鉴权**：`_token === ADMIN_TOKEN` **且** `mode:'purge'` 时必须额外传 `confirm:'PURGE'`（双保险防误触） |
| 15 | `init_db` | `{ _token, mode?: 'preview'\|'create', collections?: string[] }` | `{mode,total,created[],missing[],ready,collections{name:{exists,docs}},descriptions[],indexes[]}` | **数据表体检 / 初始化（幂等）**。云开发的集合必须先「存在」才能读写，否则抛 `Db not exist`；本函数用 `db.createCollection()` 建缺失集合（已存在的按 `already exist` / `-501001` 识别后跳过），`preview` 模式只体检、不写任何数据。**⚠️ 云开发 SDK 只能建集合、不能建索引**，故返回体 `indexes` 是必须在控制台手工创建的清单（含 `words` 的 `audioReady + seq` 出词关键索引）。**鉴权**：`_token === ADMIN_TOKEN`，未配置则拒绝一切调用。见 `docs/deploy.md` 第 5 节 |
| 16 | `start_extra_round` | `{}` | `{roundId,wordIds,reused,exhausted}` | **加练发起**（M13/T1）。前置：当日 plan 存在 **且 已打卡**（D1=A）。幂等：末尾有未完成的组则原样复用（`reused:true`）。~~上限 3 组/日~~ **上限已取消（2026-09-29，不限次数）**，唯一终点是词库取尽。取 `seq > wordCursor` 且 `audioReady` 的词，排除当日 `newWordIds` 与已出过的加练词；取尽返 `exhausted:true` 且不建空组。**不推进 `wordCursor`**（学完才推） |
| 17 | `finish_extra_round` | `{ roundId }` | `{already,roundId,learnedCount,totalLearned}` | **加练结算**。幂等（组 `stage==='done'` 直接返回，**绝不重复累加计数**）。前置：该组 `practiceQueue` 全 passed。推进 `wordCursor` 到本组 max(seq)、**`totalLearned += wordIds.length`**、加练词入复习池（`nextReviewDate=次日`）、组 `stage='done'`。**⛔ 不写 `checkins`、不改 `streak`/`plan.stage`** |
| 18 | `dismiss_wrong` | `{ wordId }` | `{wordId,updated,scheduleSynced}` | **错题本「已掌握」**（用户追加，非原型项）。把该用户该词的**所有答错记录**打 `mastered:true`（`updated` = 命中条数），`stats` 随即不再下发该词。**⚠️ 不删流水**（见 §4.5 `records.mastered` 的取舍说明）；幂等——重复标记只是重写同一个值，无副作用，故不额外加「未标记」条件（少一个 `where().update()` 的 command 不确定项）。**R1**：同时把 `user_words` 该词置 `mastered`（`nextReviewDate=''`）同步出复习池；无该词记录则不建（`scheduleSynced=false`，学了没打卡→次日重学自愈）。只影响「明天起」 |

---

## 6. 前端页面（共 8 个）

| 页面 | 路径 | 数据来源（云函数） | 关键行为 |
|---|---|---|---|
| 首页 | `pages/index` | `home_summary` + `today_flow` | 计算进度百分比；按 `stage` 生成 CTA 文案与跳转目标（`review` → 「先复习昨天的单词」→ 练习页 review 阶段；2026-10-14 用户拍板用「昨天」而非「到期」——断档场景虽不准，但符合用户对这条链路的认知，见 §12.17）；未 `onboarded` 则 redirect 到 onboarding；底栏另挂「再学一组」按钮（**仅当日已打卡后显示**，读 `today_flow.extra`）。显隐优先级：**有未完成组（`pendingRound`）→ 必显示且文案「继续学一组」（优先于上限判断）** ＞ `exhausted`/`limitReached` → 显示但置灰 + 底栏说明原因 ＞ 正常 → 可点。⚠️ **不得静默隐藏**（见 §12.13） |
| 引导 | `pages/onboarding` | `user_profile(setGoal)` | 选 5/10 → 写目标 + `wx.setStorageSync('onboarded',true)` → reLaunch 首页 |
| 单词卡 | `pages/learn` | `today_flow` / `start_new_words` / `word_card` / `today_flow(markLearned)` | 逐张卡片；**进词自动播单词发音**；**预取下一张**触发 AI 生成；`next()` 时 `markLearned`（带连点锁）；最后一张跳 `practice?phase=practice`；单词/例句发音。**「上一个」按钮**（2026-10-14）：`wx:if="{{index > 0}}"` 渲染（首词没有上一个，JS 里 `index<=0` 再兜一道），与 `next` 共用 `locked` 连点锁，走 `loadCard(index-1)` 命中缓存卡（不重发请求）；**不撤 `markLearned`** —— 走过的词就是学过了，云端 addToSet 幂等，撤了才会让今日进度造假。**`?round=N` 为加练模式**：词源取 `plan.extraRounds[N].wordIds` 并**跳过该组已学过的词**（按 `learnedIds`，剩余为空则直接跳小测）、「加练单词」标签、`markLearned` 带 round。**`?review=<wordId>` 为错题复习（W2）**：词源**只来自参数**，单卡、「错题复习」标签、按钮「复习完成」→ `navigateBack` 回错题本；**不读 `today_flow`、不调 `start_new_words`、不写 `markLearned`**（否则点一下错题本就会推进当日游标、污染今日进度） |
| 练习 | `pages/practice` | `build_questions` / `submit_answer` / `finish_extra_round` | `phase` 由 URL 参数决定；**判题在本地同步完成**（答案随题下发，点下去立即出对错、立即发音，不再等云函数）；答对自动进下一题（900ms），答错标错并**禁用该选项要求重选**（禁选项有可见的「已排除」灰度 + ✕ 态）；`submit_answer` 只做后台串行落库，跳转前等它排空（见 §7.5）。**已 `passed` 的题直接呈已答对态并自动过**（R3：复习中途退出重进时 `build_questions` 复用整条 queue；只在呈现层跳过，`questionIndex` 是落库下标、队列顺序动不得）。review 全对跳 learn，practice 全对跳 checkin。**`?round=N` 为加练**：出题/落库带 round，全对后 `finish_extra_round` 再 `switchTab` 回首页。**选项区落点**：整页 flex 拉伸，选项吃掉题干以下的剩余高度并居中分布，落在屏幕下半区（拇指可达），见 §11.9 |
| 打卡 | `pages/checkin` | `finish_checkin` | 进入即打卡（幂等）；展示 streak / 当日词数 / 累计 |
| 统计 | `pages/stats` | `stats` | 本地生成当月日历格子，标记已打卡日 |
| 错题本 | `pages/wrongbook` | `stats`（wrongWords） / `dismiss_wrong` | 展示错词。**点卡片 → 进学习页复习该词**（`/pages/learn/learn?review=<id>`，W2）；喇叭是独立的 `catchtap` 热区（只发音、不跳转）；**每项带「已掌握」按钮**（`catchtap` 拦冒泡）→ `wx.showModal` 二次确认 → **乐观移除**（不等云函数往返）+ 失败回滚、顶部提示条（本页有 tabBar，M19-1 禁用 `wx.showToast`） |
| 我的 | `pages/profile` | `user_profile` | 展示用户；改目标（提示「次日生效」）；统计/错题本入口 |

---

## 7. 核心业务逻辑

### 7.1 每日闭环状态机（`daily_plans.stage`）

```
[首次进今日流程] today_flow 创建 plan
      │
      ├─ 有 pending review（status≠mastered 且 nextReviewDate≤今天） → stage = review
      └─ 否则                                                   → stage = learning
      （若今日已存在 checkins → 直接 stage = done）

review ──(reviewQueue 全对)──▶ learning ──(学完 newWordIds)──▶ practice
                                                                    │
                                              (practiceQueue 全对)   ▼
                                                          practice_done
                                                                    │ finish_checkin
                                                                    ▼
                                                                  done
```

- 前端不做状态推断，一切以 `today_flow` 返回的 `plan.stage` 为准。
- `stage` 的推进由 `submit_answer`（review→learning、practice→practice_done）与 `finish_checkin`（→done）完成。

> **加练是主流程之外的一条旁路**：它有自己的 `plan.extraRounds[].stage`（`learning → practice_done → done`），
> 与主流程 `stage` **完全隔离**。隔离靠 `build_questions` / `submit_answer` / `today_flow(markLearned)` 的 `round` 参数路由——
> 少了它，加练会写进主队列与主讲度（§11.5 的 C2/C3/C4 三个静默破坏点）。
> 加练完成**不产生 checkins、不改 streak**，只推进 `wordCursor`、把词放进复习池，并**计入 `totalLearned`**
> （D3 于 2026-09-29 由「不计入」改为「计入」；只在结算时按整组入账，口径与 `finish_checkin` 对称）。
> 计数的回归测试见 `scripts/test_finish_extra_round.js`。

### 7.2 登录与首次引导
- 无账号体系，用 `OPENID` 作为唯一标识（云函数自动注入上下文）。
- 用户记录在各云函数内**惰性创建**（`getUser` 查无则建，默认 `dailyGoal:5, wordCursor:0`）。
- 首次进入首页若本地无 `onboarded` 标记 → 跳 onboarding 选目标。

### 7.3 出词策略（顺序学习，非随机）
- `word_card` 不参与出词。`start_new_words` 按 `words.seq` **升序**取满足 `seq > user.wordCursor` **且 `audioReady === true`** 的前 `dailyGoal` 个。
- **只出有发音音频的词**：音频由本地离线预生成后经 `seed_audio` 上传并置 `audioReady=true`，因此没音频的词永远不出现在学习流程里（见 7.8 / 7.9）。
- `wordCursor` **只在打卡成功时**更新，取当日已学词的最大 `seq`（**不是** `+learnedCount`）。因为带 `audioReady` 过滤后词可能不连续，按数量累加会错位、导致重复出词。当日队列在未打卡前保持不变（幂等、可恢复）。
- 词库取尽（`newWordIds` 为空）→ `exhausted:true`，且 `stage` 置 `done`。
- ⚠️ 音频应**按 seq 从前往后连续生成**。跳着生成不会出错，但学习顺序会出现空洞。

### 7.4 复习调度（R6：仅昨日新词，一轮一次性测验）
- **状态机**（`user_words.status`，三态）：
  - `reviewing`：在复习池中。**进池只有一条路** —— `finish_checkin` /
    `finish_extra_round` 注册当日新词/加练词（`nextReviewDate = 明天`）。
    所以池内 = 昨日新词（含加练词），没有第二条入池路径。
  - `mastered`：毕业终态。review 阶段 clean（一轮一次答对 + 历史无错），
    或用户在错题本点「已掌握」（`dismiss_wrong`）。
  - `reviewed`：**出池终态**（R6）。过了复习轮但出过错 —— 次日不再自动复习。
- **待复习集合**：`user_words` 中 `status = 'reviewing'`（**正相匹配**）**且**
  `nextReviewDate <= today`，上限 50 条，**按 `nextReviewDate` 升序**取
  （R4：无排序会按自然序截断，断档积压时队尾饿死）。
  - ⚠️ 必须正相匹配，**不能**用 `_.neq('mastered')`：出池终态 `reviewed` 也是
    「非 mastered」，用 neq 会把答错的词捞回池里，「错词次日不再自动复习」
    被悄悄破坏（且不报错）。
  - ⚠️ 用 `lte(today)` 而不是 `== today`：断档 N 天回来时，之前注册没来得及
    复习的词要能补上（配合升序，最老的先复习）。
- **答对时**（review 阶段）：`clean = !本次答错 && 历史 wrongCount === 0`
  - clean → `status='mastered'`，`nextReviewDate=''`（毕业）
  - 否则 → `status='reviewed'`，`nextReviewDate=''`（**出池**，不次日复习）
- **答错时**（任何阶段，uw 存在）：`wrongCount+1`，`status='reviewed'`，
  `nextReviewDate=''`。当天同一题仍要重选到对才能过（前端禁选 + `passed`
  由答对时置位），先出池不影响当天流程。
- **出池词的出路**：答错流水都在 `records` → 错题本照收；用户练熟后在错题本
  点「已掌握」（`dismiss_wrong` 同步置 `mastered`）才算真正掌握 —— 这是
  `reviewed` 转正 mastered 的**唯一入口**。
- ⚠️ **「历史 wrongCount」包含昨天练习阶段答的错**（R2）：新词首次做题时 `user_words`
  还没有记录（要等打卡才建），所以 `submit_answer` 在 practice/加练阶段答错且无记录时，
  先落一条**只带 `wrongCount:1`** 的记录（不写 `status`/`nextReviewDate` —— 没打卡的词
  走「次日重学」而非「次日复习」）；`finish_checkin` 的幂等分支补调度字段且**不覆盖
  wrongCount**。少了这一步，昨天练习答错的词次日一轮答对就会被误判 mastered。
  ⚠️ R6 之后该记录的后果是「出池而非毕业」：次日复习答对也因 `wrongCount>0`
  非 clean → `reviewed`，要等用户在错题本点「已掌握」才 mastered。
- ⚠️ **错题本「已掌握」会同步出复习池**（R1）：`dismiss_wrong` 打 `records` 标的同时把
  `user_words` 该词置 `mastered`（`nextReviewDate=''`）—— 两套系统不通时，用户点了
  「已掌握」次日复习照考。`user_words` 无该词记录时不建（学了没打卡→次日重学自愈）。
  同步只影响「明天起」：当日 `reviewQueue` 是建 plan 时的快照。
- > 未实现完整艾宾浩斯/FSRS，`round` 字段为 v2 预留。

### 7.5 题型生成与判题（本地同步判题）
- **两种题型**：`cn_option`（中选项：题干英文单词→选中文释义）/ `en_option`（英选中：题干中文释义→选英文单词）。
- 同一批题目按 `i % 2` **交替**分配题型，再整体 shuffle 混合。
- **干扰项**：从**不在本批**的词库中随机取 3 个（`_id nin wordIds` 的池，池不足 3 则放宽到全库）。
- **题干**：cn_option 用 `w.word` 且带音标；en_option 用 `w.meaning`。
- **答案随题下发**：题目带 `answerIndex` 存 `daily_plans`，`toClient()` 下发的形状为
  `{id,wordId,type,stem,phonetic,roots,options,answerIndex,audioText}`（**复用分支同样带**，老队列里本来就有 `answerIndex`）。
  - `audioText` = 答对后要读的英文：cn_option 是题干（英文词）、en_option 是正确选项。
    ⚠️ **判据必须是 `type`**，不能用「`phonetic` 是否为空」来推 —— 没音标的 cn_option 会被推成中文释义，
    前端拿去查音频必然落空（`test_build_questions.js` 钉住这条）。
  - `roots` = 词根拆解（D15，2026-10-22）：练习页题干区在「单词 → 音标」之下展示，**仅 cn_option 用**
    （en_option 题干是中文释义，露词根等于给选项送答案）。旧队列没有该字段 → 兜底 `[]`，前端不渲染（可选内容）。
- **判题时机**：前端 `choose()` 本地比对 `choice === answerIndex` → **点下去立即出对错、立即发音**，不等云函数往返。
  答错**不移除题目**，禁用该选项要求重选，直到答对。
- **落库与判题解耦**：`submit_answer` 退化为**后台任务**（写 `records` / 推进复习状态 / 推进 `stage`），前端**不等它**。
  由此产生三条硬约束（改这块必读，均有回归钉住）：
  1. **串行提交**：`submit_answer` 是「读整个 queue → 改 → 写回整个 queue」，并发提交会互相覆盖（后写的把先写的 `passed/wrong` 抹掉）→ 前端用一条 Promise 链串住所有提交（`syncAnswer`）。
  2. **跳转前 flush**：`finish_checkin` / `finish_extra_round` 的前置是「该 queue 全部 `passed`」，而 `passed` 是 `submit_answer` 写的 → `next()` 在终点分支先 `await flushSync()`。不加就会出现「题全答对了，打卡却提示没做完」。
  3. **失败不静默**：落库失败先重试一次，仍失败则明确提示（判题已在本地完成，落库静默失败 = 正确率/错题本/复习调度的静默缺口）。
- **降级路径**：题目不带 `answerIndex`（云函数未升级 —— 前端先发布了而忘了部署函数）时，前端回退到
  「等服务端判题」的旧行为。不留这条路的话，每个选项都会被判错、逐个禁掉，用户直接卡死。
  功能不受影响，只是慢。

### 7.6 打卡（`finish_checkin`）
- 前置校验：`practiceQueue` 非空且 `every(q => q.passed)`。
- 幂等：今日已有 `checkins` 记录 → 返回 `already:true`，不重复累加。
- 更新：`streak`（昨天打过则 +1，否则置 1）、`lastCheckinDate`、`totalLearned` 各按 `learnedCount` 累加；`wordCursor` **取当日已学词的最大 `seq`**（不再按词数累加，理由见 7.3）。
- 新词注册复习池 + `stage='done'`。

### 7.7 AI 内容生成与缓存（降本关键）
```
word_card(wordId)
  └─ enriched === true ? ──是──▶ 直接返回（命中缓存，不调模型）
        │否
        ▼
   callFunction(enrich_word, {wordId})
     └─ 乐观锁：update where enrichStatus != 'generating'
          ├─ 抢锁成功 → 调 DeepSeek(JSON Output) → msgSecCheck → 写回 enriched=true
          └─ 抢锁失败（他人生成中）→ 返回 {locked:true}
     └─ word_card 再读一次，返回最新内容 + enriching 标记
```
- **乐观锁**：`enrichStatus: pending → generating → ok/failed`，保证同一单词**全局只生成一次**。
- **失败降级**：写 `enrichStatus:'failed'` + `enrichError`，返回词表基础字段，不阻断学习。
- **定时重试**：`enrich_word` 配置定时触发器（`event.Type === 'Timer'`）——释放超过 60s 的 `generating` 锁、批量重试 `pending/failed` 词条（每批 10 条）。
- **JSON 解析失败**重试 1 次（`MAX_ATTEMPTS=2`）；鉴权/余额/超时类错误不重试。
- **写回注意**：`example`/`roots` 用 `_.set()` 整体替换，避免 SDK 对嵌套对象做点操作（字段为 `null` 时会报 `Cannot create field 'x' in element {y:null}`）。

### 7.8 离线音频生产流水线（本地）
音频**全部在本地生成，云端只负责存储与索引**，运行时不调用任何 TTS。四步：

```
① 抽词表   build_wordlist.py   ECDICT(ecdict.csv) → assets/word_lists/*.json
                               （筛 tag 含 ielts，按 bnc 排序，排除基础词/无音标/词组）
                               同形异音词另存 *-homographs.json
② 生成音频 gen_audio.py        Kokoro-82M(本地 CPU) → build/audio/us/{slug}.mp3
                               --offset/--limit 增量续跑，已存在文件自动跳过
                               默认 --types us（只做美音，type=2）
③ 预检试听 make_audition_page.py → build/audition.html + build/audition_check.json
                               校验 TEXT_RE / slug 撞车 / mp3 头 / 体积 / 缺音频
④ 打包上传 pack_audio.py       → build/seed_audio/batch-NN.json（base64，按 --max-bytes 分批）
                               → 控制台「云端测试」调 seed_audio 云函数
```

**为什么用 base64 走云函数而不是直接传文件**：云函数入参只能是 JSON，无法携带二进制；
`pack_audio.py` 把 mp3 编码成 base64 内嵌进 `items[].base64`（体积膨胀约 1/3，故按
`--max-bytes`（默认 350KB）自动分批，避免超过云函数入参上限）。

**一次 `seed_audio` 调用做三件事**（幂等，可重跑）：
1. `cloud.uploadFile` → 云存储 `audio/{type}/{slug}.mp3`
2. upsert `audio_cache` 集合 `{text, type, fileID, source:'preseed', bytes}`
3. `words` 中同名词置 `audioReady=true`（分批 `_.in(chunk)` 更新）

**关键约束**：
- 音频必须按 `words.seq` **从前往后连续**生成（`finish_checkin` 的游标按 seq 推进，见 7.6）
- `slug()` 必须两处一致：`scripts/gen_audio.py` 与 `cloudfunctions/seed_audio`；`scripts/make_audition_page.py` 直接 `from gen_audio import slug` 复用，**不另写实现**（少一处要同步的地方）
- 词名必须满足 `TEXT_RE = /^[A-Za-z][A-Za-z'\u2019\- ]{0,39}$/`，否则云端抛 `INVALID_WORD`
- 同形异音词（`contract` 合同/收缩 等）TTS 只念一个读音，需人工试听后定向重生成

**例句音频（额外一条流水线，可选）**

难点：例句文本原本由 `enrich_word` 在**运行时**调 DeepSeek 生成，本地合成音频那一刻并不知道要念什么，
因此必须先把例句**离线化**，再合成音频：

```
① 生成例句 gen_examples.py       词表 + DeepSeek(JSON Output) → assets/examples/*-examples.json
                                 prompt/model/temperature 与 enrich_word 逐字对齐；顺带落盘 roots/etymology
                                 已存在自动跳过；失败清单同目录，重跑补齐
② 合成音频 gen_sentence_audio.py Kokoro → build/sentence_audio/us/s_{hash}.mp3
③ 本地自测 make_audition_page.py --examples <例句JSON> → 预检 + build/audition_sentence.html 试听页
④ 打包     pack_audio.py         按 manifest 条目是否含 text 自动生成句子入参（kind:'sentence' + text）
⑤ 填密钥   fill_token.py         整目录一次性替换 __ADMIN_TOKEN__（批次多，手工改易漏）
⑥ 上传     seed_audio 云端测试   → 云存储 + audio_cache(kind='sentence')；**不点亮 audioReady**
```

- 例句**不能用 slug 命名**：整句长达数十字符且含标点，转 slug 会超长、句末标点被替换为空后还易碰撞 → 统一用 `s_{hash}`
- `hashText()` 必须三处一致：`gen_sentence_audio.py` / `seed_audio` / `audio_cache`（均为 JS int32 语义，已用同一组样本实测比对一致）
- 例句音频**只能由 `seed_audio` 预置**：`audio_cache` 对 `kind:'sentence'` 只查库、不下载也不写存储（见 7.9）
- ⚠️ 例句音频以**整句文本**为 key → 若用 `force:true` 重新生成 AI 内容，例句文本一变旧音频即失效，需重跑 ②③④⑤⑥
- 例句入参校验用 `TEXT_RE_SENTENCE = /^[A-Za-z][^\x00-\x1F\x7F\\`]{0,199}$/`，即**排除集**而非标点白名单：真实例句含 `%`（`over 70% of ...`），白名单漏一个标点该条音频就查不到；该正则需在 `seed_audio` / `audio_cache` / `make_audition_page.py` **三处同步**。本地已实测该正则对 100 条真实例句的判定三处逐条一致
- 体量：实测约 21KB/条（单词约 6KB），按每批 base64 ≤600KB 切 → 100 条例句分 5 批；3000 词约 65MB 存储
- `gen_examples.py` 的 prompt 模板**不要用 `str.format()`**：模板里塞着 JSON，花括号成对出现，必须逐个转义成 `{{ }}`，漏一个就报 `KeyError`（曾踩过，已改为 `__WORD__` 风格的手动替换）

**每日一句音频（第三条流水线，2026-09-29 补）**

首页「每日一句」的喇叭走的是**例句音频链路**（`playQuote` → `audio.playSentence` → `audio_cache` `kind:'sentence'`），
而 `audio_cache` 对例句**只读不写**，所以这 12 句必须有音频**预先入库**——否则查不到 →
`playSentence` 的 `if (!src) return` **静默跳过** → 点喇叭既不响也不报错（这正是上线初期「每日一句没声音」的根因）。

```
① 转格式 quotes_to_examples.py   miniprogram/utils/quotes.js → assets/examples/quotes-12.json
                                 从 quotes.js 现抽现转，**quotes.js 恒为唯一数据源**（手工维护第二份清单必然漂移）
② 合成   gen_sentence_audio.py   Kokoro → build/quote_audio/us/s_{hash}.mp3（实测 12 句 / 216KB / 平均 18KB）
③ 上传   seed_quote_audio.py     --apply → 云存储 audio/2/s_{hash}.mp3 + audio_cache(kind='sentence')
                                 复用 wxcloud.py 的 Cloud 句柄，**不需要 ADMIN_TOKEN、不经过 seed_audio 云函数**
```

- `seed_quote_audio.py` 自带三道自检：① 文本过云端正则 `TEXT_RE_SENTENCE`（否则传了也查不出）② 文件名 hash 与文本重算值一致（防三处算法漂移）③ 本地 mp3 存在；`--apply` 才动云端，默认只读体检
- 幂等键 `(text, type)`；`--force` 可覆盖重传（换音色时用）
- 与 `seed_cloud.py` **分开**的原因：那边的例句音频强绑定 pilot-100（`load_local()` 会校验「音频 manifest 的句子 == 富化例句文本」，混进去直接 `sys.exit`），且每日一句与词表毫无关系，不该被 `--reset` 之类动作牵连
- ⚠️ **改了 `quotes.js` 的句子就必须重跑 ①②③**——音频以整句文本为 key，改一个字旧音频即失效（与 `force:true` 重生例句同理）
- `scripts/quotes_to_examples.py` 会断言「抽到的条数 == quotes.js 里 `text:` 的声明条数」，防正则漏收

### 7.9 发音（离线预生成音频 + 本地文件缓存 + 预加载）

**四层缓存，就近优先**（`utils/audio.js`）：
```
playWord / playSentence
  ① L0 内存 memo（本次运行）              ──命中──▶ 秒播
  ② L1 本地文件 USER_DATA_PATH/audio/*.mp3 ──命中──▶ 秒播（零网络）
  ③ 未命中 → 立即用远端起播（不等落盘，首播不比旧版慢）
        └─ 同时【后台】把远端写进 L1，下次即走 ②
  ④ 远端来源：callFunction(audio_cache) → 云存储 fileID
        └─ 查 audio_cache 集合 {text,type} ──命中──▶ 返回 fileID
        └─ 未命中 → 下载 dictvoice → 上传云存储 → 写索引   ← 仅词表外单词会走到这里
        └─ 云函数失败 → 单词降级直播 dictvoice URL；例句静默不播
```
- **首播为什么不等落盘**：`wx.cloud.downloadFile` + `saveFile` 要一个完整往返，若先落盘再播，首播会比旧版更慢。改成「先用远端流出声、后台并行落盘」，首播与旧版持平，第二次起才是「本地秒播」的收益。
- **预加载**（本次新增，消灭「翻页才转圈」）：`preloadWords(list)` / `preloadSentences(list)` 只落盘、不发声，走**统一队列**（并发 3、同批去重、并发请求合并 `pending`）。`USE_MOCK` 时整体旁路（mock 音频是远端直链，预加载等于白联网）。
- **预加载接入点（4 处）**：
  | 页面 | 时机 | 内容 |
  |---|---|---|
  | `learn` | 开页即按窗口预取**卡片**，卡片一到手就排音频 | 该词的词音频 + 例句整句音频（预取窗口 3 张，见下） |
  | `practice` | 拿到 questions 后 | `cn_option` 预载 `stem`；`en_option` 预载 4 个英文选项（答对后的 `playWord(res.word)` 必在其中） |
  | `index` | `load()` 里（早于云端接口等待） | 每日一句整句音频 |
  | `wrongbook` | `onShow` 拿到错词表后 | 整表错词 |
- **`learn` 的卡片预取窗口**（`PREFETCH_AHEAD = 3`）：`prefetch(i)` 幂等（同一个 promise 复用，`loadCard` 与预取窗口共用），命中时翻页同步出卡。开页即 `prefetchWindow(0)`，让第 2、3 张**并行**发出而不是等第 1 张一个完整往返 —— 这才是「点下一个就立刻出声」的关键。预取失败**不缓存**（否则那张卡永远白屏），翻到它时会重新请求。
- **`warmup()`**：app 启动即空调一次 `audio_cache`（空 text 会被立刻拒绝，不写库、不外呼、无数据），把云函数**冷启动**从首次点喇叭挪到启动阶段 —— 那是「第一次点要等一下」的大头。
- **本地缓存上限 50MB + LRU 淘汰**：官方「本地缓存文件 + 本地用户文件共计 200MB，超了写入直接失败且平台不自动清理」。实测单词 ~4KB、例句 ~22KB，50MB 足够装下数千个词。超限按 `t` 最旧删到 80% 水位，并清掉记录里的 `local` 指针与内存 memo。
  ⚠️ **冷启动不逐个 `accessSync` 校验索引**：同步 JSBridge 调用 ×几百条 = 首次发声卡上百毫秒。脏行改为按需精确清理（读到记录发现文件不在 → `indexDrop`；淘汰时 unlink 失败 → 该行本就死了）。`test_audio.js` 的 L1 用「检查次数与索引长度无关」把这条钉死。
- **缓存键与记录**：storage 键 `audio_cache_{type}_{text}`，值 `{ fileID, url, local, size, ts }`（旧记录只有 `fileID`，**天然向后兼容**）；`audio_cache` 集合跨用户共享。本地文件名 `{type}_{双哈希}.mp3` —— 双哈希是**本地专用**，与 `scripts/text_key.py` 的跨运行时 `hashText` 无关，改动不影响线上数据。
- **主音源是云存储里的离线音频**，由本地 `scripts/gen_audio.py` 用 **Kokoro-82M（Apache-2.0）** 批量合成，**当前先只做美音**（type=2，voice=`af_heart`，lang_code=`a`）——因为前端 `config.TTS_LANG='en_US'` 映射出的就是 type 2，足够覆盖全部播放场景；英音（type=1）留到将来做「英美音切换」时用 `--types uk` 增量补。mp3 约 5KB/词。经 `seed_audio` 上传并写入 `audio_cache` 索引后，运行时**零第三方外呼**。
- `audioReady` 机制保证学习流程里出现的词都已有音频，故第 ④ 步的 dictvoice 分支实际不会触发；保留它主要为词表外单词兜底。
- 音频全部自持后，可**移除** downloadFile 合法域名 `https://dict.youdao.com`（⚠️ 移除后 dictvoice 兜底链路会一起失效，且 `wx.downloadFile` 也被预加载用于兜底音频落盘）。
- 云存储路径有两种，别混：**预置音频**是 `audio/{type}/{slug}.mp3`（单词）与 `audio/{type}/s_{hash}.mp3`（例句，见 7.8）；**dictvoice 兜底**落盘为 `audio/{type}_{hash}.mp3`。两者互不影响，排查时按来源看 `audio_cache.source`（`preseed` / `dictvoice`）。
- `playSentence(text)`：播放**整句音频**（本地 Kokoro 预生成，见 7.8 例句流水线），以**整句文本**为 key 查 `audio_cache`。**无 dictvoice 兜底**（实测整句请求 dictvoice 返回 HTTP 500 / 120 字节 JSON，必失败）；云端返回 `NOT_PRESEEDED` 时**静默不播** —— 补音频是渐进的，期间大量例句尚无音频，弹提示会持续打扰学习。早期的「逐词链式朗读」实现已废弃（听感生硬）。
- `playWord(word)` 的调用方：① learn 页 —— **进入每个单词页自动播一次**（`loadCard()` 里 `setData` 之后调，首个词与「下一个」共用同一入口）+ 喇叭按钮手动重播；② 练习页答对后的反馈音；③ 错题本喇叭。自动播放在 `setData` 之后触发，保证「词先出现、再出声」；连点由 `locked` 挡住，`playSrc` 内部先 `ctx.stop()` 也不会叠音。
- `playSentence` 的**两个调用方**都要在这里对号：① learn 页单词卡的例句（见 7.8 例句流水线）② 首页「每日一句」（见 7.8 每日一句流水线，12 句已全部预置）。**任一路径新增句子而没补音频，症状都是「静默不播」**，排查先查 `audio_cache` 有无该整句文本。
- ⚠️ **`cloud://` fileID 不能直填 `InnerAudioContext.src`（真机截断坑）**：开发者工具里正常，
  真机上会**播放中途截断**（实测：每日一句第一次播两个词就停，第二次点因内部缓存才完整）。
  ① 本地路径不经这一步；② 未命中本地时用 `wx.cloud.getTempFileURL` 转成 https 临时链接，
  内存缓存 100 分钟（临时链接有效期 2h），转换失败降级回 fileID（宁可冒截断风险也不哑掉）。
- 停止：`stop()` 中断并清事件监听。tab 页（index / wrongbook）在 `onHide` 停播，普通页在 `onUnload` 停播。
- 配置：`config.TTS_LANG` 映射 type（`en_US`→2，`en_GB`→1）。
- 回归：`scripts/test_audio.js`（46 条：四层命中 / 跨启动恢复 / 文件被回收 / 队列并发与去重 / LRU 淘汰 / 冷启不扫索引 / 三条降级路径），另有各页面侧的预加载断言（见 11.6）。

### 7.10 日期与时区
- 云函数统一 `dateStr(offset)`：`Date.now() + 8h` 后取 UTC 部分格式化 `YYYY-MM-DD`（即 **GMT+8** 自然日）。
- 前端 `stats` 页日历用**本地时间** `new Date()` 生成——理论上两端时区应都为 GMT+8，无差异。

### 7.11 分享转发（`utils/share.js`）
- 8 个页面**全部**实现 `onShareAppMessage()`，内容由 `share.toFriend(opts)` 统一生成，缺省标题 `雅词本｜每天记住几个核心词`。
- **分享路径统一回首页** `pages/index/index`（含 learn / practice / checkin 等强流程页）。原因：新用户从卡片直接进入流程页会立刻创建当日学习计划，体验突兀；回首页最干净，未设置目标的新用户由 index 自动引导到 onboarding。
- 部分页面用**上下文文案**增强信息量：`learn` 带当前单词、`checkin` 带连续天数、`stats` 带累计词数、`wrongbook` 带错题数；数据缺失时回落到默认文案。
- **朋友圈（`onShareTimeline`）：仅首页开启** —— 2026-09-30 用户拍板，**反转**了此前「不开朋友圈」的决策。这是本轮最容易踩错的一处，四个要点：
  1. **两个必要条件**：页面实现 `onShareTimeline()` + 微信后台开启「分享到朋友圈」能力。缺一即静默无效。
  2. **朋友圈打开走「单页模式」（scene 1154）**：**无登录态、存储隔离、不允许跳转**。本项目云数据全部以 openid 为键、云开发「未登录访问」又保持关闭 → 直接照常渲染**必然空白**。
  3. **因此首页做单页模式降级**：`onLoad` 检测 scene 1154 → 置 `singlePage`，**跳过 reLaunch onboarding**（单页模式不允许跳转；且 `getStorageSync` 被隔离必为空，会误判成新用户而触发跳转）；`load()` 早退**不打任何云端接口**；落地视图 = 品牌 + **本地静态**每日一句（`utils/quotes.js`）+「点右上角前往小程序」引导，并隐藏打卡/进度/底栏/喇叭。**单页模式能撑住内容，全靠每日一句是纯前端静态数据**。
  4. **learn / practice 等强流程页绝不加 `onShareTimeline`** —— 它们没有静态内容可撑，单页模式进来必然死亡。
  - 文案与好友转发区分：朋友圈走 `share.toTimeline()`（`雅词本｜一天一句好英文，顺手记住几个核心词`，不催打卡、无诱导词）。回归：`scripts/test_index.js`（含 scene 1154 不跳转/不打接口的负向断言）。
- 打卡成功页（`checkin.wxml`）内置 `<button open-type="share">分享给朋友</button>`，是唯一的前端显式分享入口。
- 分享卡片配图：`share.js` 的 `SHARE_IMAGE` 常量，**当前留空**（用系统页面截图 + 小程序 Logo）。要自定义就把图放进 `miniprogram/images/`（该目录已存在，放的是 tabBar 图标），再把常量改成 `/images/share.png`——**图片必须在 `miniprogramRoot` 内才会被打包**（`assets/` 在包外，放那里不生效）。⚠️ **两种分享的配图比例不同**：好友转发卡建议 **5:4（500×400）**，朋友圈是 **1:1**，同一张图会被裁切；若要两者都好看需分别给图（`toFriend` / `toTimeline` 均接受 `imageUrl`）。
- 文案红线：不得出现「分享得奖励」「帮我点一下」等诱导性表述（《微信小程序平台运营规范》诱导分享条款）。

---

## 8. 关键约定与已知边界

| 项 | 约定 / 约束 |
|---|---|
| 云函数返回 | 一律 `{code, data?, message?}`；`code===0` 成功 |
| 云函数命名 | **不得以下划线开头**（腾讯云 SCF 规范）。历史 `_enrich_word`/`_seed_words` 已改名 |
| 用户身份 | 只用 `OPENID`，云函数侧取上下文，前端不传 |
| 密钥 | DeepSeek Key 只配在 `enrich_word` 环境变量；**前端包体不得出现 `sk-`**；`ADMIN_TOKEN` 需在 `enrich_word` / `seed_words` / `seed_audio` / `reset_words` / `init_db` **五个函数**上分别配置（同一值），用于锁住管理类能力。⚠️ 环境变量是**函数级隔离**的，逐个配、别漏 |
| 云函数鉴权 | 云函数 = 公开接口，入参可伪造。管理/花钱/写库类能力必须自带校验：`enrich_word.force` 需 `_token`；`seed_words` / `seed_audio` / `reset_words` / `init_db` 强制 `_token`（`reset_words` 执行删除还需 `confirm:'PURGE'`）；`audio_cache` 限制 `text` 正则 |
| 数据表初始化 | 集合必须先存在才能读写。建集合两条路：`python scripts/init_cloud.py --apply`（本地，顺带建索引）或控制台 `init_db` 云函数。⚠️ **安全规则只能手工设**（微信云开发 HTTP API 没有该接口） |
| 词表导入语义 | `seed_words` = 按 `word` 去重**跳过**，**永不覆盖**已存在词条（只 `skipped++`）。要替换词库必须先 `reset_words` 清空。⚠️ 不可只删 `words`：`user_words` / `records` / `daily_plans` 均按 `wordId` 引用 `words._id`，只删词会留下孤儿数据；`users.wordCursor` 也必须归零 |
| 词库重置范围 | `reset_words` 默认清 `words` + `user_words` + `records` + `daily_plans` + 归零 `wordCursor`；**保留** `audio_cache`（按 `text` 建索引，重导可复用）与 `checkins`（不含词引用，`resetStats:true` 时才清）。云存储 `audio/` 目录不删，同名文件重跑 `seed_audio` 覆盖即可 |
| 数据库写操作 | 全部在云函数（管理端）；前端只读 `words`（可选直连） |
| 答案下发 | 题目答案（`answerIndex`）**随题下发给前端**做本地同步判题（见 §7.5）。代价：客户端逆向者可读答案 —— 词汇练习类产品作弊动机极低，换「点选零延迟」值得。⚠️ 但**别把答案铺到更多地方**：`today_flow` 下发的 `plan.extraRounds` 仍会剥掉 `practiceQueue`，这条不要顺手改掉 |
| 防重复 | `start_new_words` / `build_questions` / `finish_checkin` 均幂等 |
| 集合权限 | `words` 建议「所有用户可读，仅管理端可写」，其余「仅创建者可读写」 |
| 超时 | 20s：`user_profile`/`home_summary`/`today_flow`/`start_new_words`/`submit_answer`/`audio_cache`；30s：`word_card`/`enrich_word`/`build_questions`/`finish_checkin`/`stats`/`start_extra_round`/`finish_extra_round`；60s：`seed_words`/`seed_audio`/`reset_words`/`init_db`；**10s：`dismiss_wrong`**（一次数据库 update，无外部依赖）。均由各函数 `config.json` 声明，部署后可在控制台核对 |
| 分享 | **好友转发**：8 页全开 `onShareAppMessage`，路径统一回首页。**朋友圈**：**仅首页**开 `onShareTimeline`（单页模式 scene 1154 无登录态 → 首页降级为「品牌 + 本地每日一句」；强流程页不加）。详见 §7.11 |
| 产品命名 | 对外文案一律「**雅词本 / 核心词**」。**「雅思」是他人注册商标，禁止出现在小程序内文案、分享卡片与提审材料中**（铁律：`grep -rn "雅思" miniprogram/` 必须 0 命中，`docs/intro.md` 同样清零）。ECDICT 的 `ielts` 标签是**数据侧内部标识**，只可出现在脚本与文档里，不得外露给用户 |
| 错题本「已掌握」 | 语义是**打标过滤**，不是删除（见 §4.5）。因为「之后再答错会自动回来」，所以**不做撤销功能、不做回收站**——这两样都是多余的。前端必须二次确认（误点代价虽低，但会打乱复习节奏） |

---

## 9. ⚠️ 已知问题与上线前待办

| 级别 | 问题 | 说明 / 处理建议 |
|---|---|---|
| **高（安全）** | ~~`enrich_word/index.js` 硬编码 DeepSeek API Key 作为 fallback~~ | ✅ **已闭环**：代码侧已改为只读 `process.env.DEEPSEEK_API_KEY`（无 fallback 字面量，2026-09-27）；暴露在历史代码中的旧 Key 已到 DeepSeek 后台**吊销并重发**，新 Key 已写入本地 `.env`（`gen_examples.py` 用）并配置到 `enrich_word` 的环境变量（2026-09-28）。仓库内已确认无任何 `sk-` 字面量残留。 |
| **高（安全）** | ~~`enrich_word` 的 `force` 参数可由客户端任意传入~~ | ✅ **已修复**（2026-09-28）：`force` 仅在 `_token === ADMIN_TOKEN` 时生效，否则忽略并记日志。未配置 `ADMIN_TOKEN` 时恒为忽略（安全默认）。修复前任何人可 `force:true` 循环调用绕过缓存烧余额。 |
| **高（安全）** | ~~`seed_words` 零鉴权，任何用户可往词库写入数据~~ | ✅ **已修复**（2026-09-28）：强制 `_token === ADMIN_TOKEN`；未配 `ADMIN_TOKEN` 时**拒绝一切调用**。⚠️ **副作用**：控制台执行导入时必须带 `_token` 入参。 |
| 中（安全） | ~~`audio_cache` 入参无限制，可被用来写满云存储~~ | ✅ **已修复**（2026-09-28）：`text` 限定为字母开头的英文单词/短语（≤40 字符），`type` 收敛为 1/2。后续新增的例句路径（`kind:'sentence'`，≤200 字符）**只查库、不下载也不写存储**，故放宽长度不会重新打开写存储的口子。 |
| 中 | 发音版权 | 有道 dictvoice 非官方开放商用接口，商用属灰色地带（每日约 1000 次上限）。**现状已大幅缓解**：单词与例句音频均由本地 **Kokoro-82M（Apache-2.0）** 预生成后上传云存储，运行时零外呼；dictvoice 仅作词表外单词兜底，可随时移除。 |
| 中 | AI 内容展示合规 | 展示 AI 生成内容需符合平台对生成式内容的相关要求。实现上是「**有则展示、无则留空**」：`enrich_word` 未成功生成的词，`word_card` 只返回词表基础字段（单词/音标/释义），扩展区块自动留空——因此展示范围可通过控制生成范围来调节。 |
| 中 | ~~词库版权~~ | ✅ **已解决**：词表取自 **ECDICT（MIT License, Copyright (c) 2025 Linwei）**，可商用、可闭源衍生；许可证副本见 `assets/word_lists/ECDICT-LICENSE.txt`。⚠️ 不要改用 ECDICT 自带的 `audio` 字段（那是第三方词典的音频 URL，会把版权风险搬回来）。 |
| 低 | 配置项 | `project.config.json` 的 `appid` 与 `miniprogram/config.js` 的 `ENV_ID` 已填为作者本人的真实值（二者均非密钥）。**fork 或二次开发后必须替换为你自己的**，否则无法调用你自己的云环境。 |
| 低 | 合规 | 小程序发布前需完成 ICP 备案。 |
| 低 | ~~文档漂移~~ | ✅ **已解决**（2026-09-28）：设计阶段历史稿（`specs/`，提到 Vant 与同声传译插件）已删除；`README.md` 已重写为精简概览并指向本文件与 `docs/deploy.md`。 |
| 低 | 文档漂移（第二轮） | ✅ **已解决**（2026-09-30，第一版封版后的梳理）：① 朋友圈决策已在代码里反转，但 §7.11 / §8 仍写着「不开朋友圈」的旧结论；② 缺省分享文案已改「核心词」但 §7.11 还写着「雅思」；③ §1 定位与 `README.md` 标题未跟合规改名；④ `README.md`「快速开始」还写控制台路径，与自身「注意事项」的本地脚本自相矛盾；⑤ 隐私指引的发音措辞仍写「服务端调第三方接口」。另：两份 UX 施工单与一次性施工提示词已合并/删除，见 §11 |

---

## 10. 快速定位索引（改需求看这里）

| 想改什么 | 去哪个文件/函数 |
|---|---|
| 每日目标选项（5/10） | `miniprogram/config.js` `DAILY_GOAL_OPTIONS` + `user_profile` |
| 出词顺序/策略 | `cloudfunctions/start_new_words/index.js`（`seq` + `wordCursor` + `audioReady`） |
| 复习调度逻辑 | `cloudfunctions/submit_answer/index.js`（R6 出池语义：clean→`mastered`，否则→`reviewed`+`nextReviewDate=''`；R2 起 else 分支还要给新词落 `wrongCount`）↔ `cloudfunctions/today_flow/index.js`（到期集合：`status='reviewing'` 正相匹配 + 升序）↔ `cloudfunctions/dismiss_wrong/index.js`（R1 同步出池；R6 起是 `reviewed` 转正 `mastered` 的唯一入口） |
| 题型比例/干扰项 | `cloudfunctions/build_questions/index.js`（`i % 2`、`sample(pool,3)`） |
| **判题时机 / 点选延迟** | `miniprogram/pages/practice/practice.js`（`choose` 本地判题 + `syncAnswer` 后台串行落库 + `flushSync`）↔ `cloudfunctions/build_questions/index.js`（`toClient` 下发 `answerIndex`/`audioText`）。改一边必改另一边，契约见 §7.5 |
| AI Prompt / 模型 | `cloudfunctions/enrich_word/index.js`（`buildPrompt` / `callModel`） |
| 发音音源（单词） | `scripts/gen_audio.py`（本地生成）→ `cloudfunctions/seed_audio`（上传+点亮）→ `miniprogram/utils/audio.js`（`resolveSrc` / `fallbackUrl`）/ `cloudfunctions/audio_cache`（读缓存） |
| **数据表初始化 / 建索引** | `scripts/init_cloud.py`（本地走 HTTP API，建集合 + 建索引，清单在 `assets/db-indexes.json`）；控制台备选 `cloudfunctions/init_db`（建集合 + 返回索引清单） |
| **部署步骤 / 报错排查** | `docs/deploy.md` |
| 例句文本来源 | 运行时：`cloudfunctions/enrich_word`（`buildPrompt`）；离线批量：`scripts/gen_examples.py` |
| 发音音源（例句） | `scripts/gen_examples.py` → `scripts/gen_sentence_audio.py`（本地生成，`s_{hash}`）→ `seed_audio`（`kind:'sentence'` 上传）→ `audio.js` 的 `playSentence` / `audio_cache`（**只读不写**） |
| 发音音源（每日一句） | `scripts/quotes_to_examples.py` → `gen_sentence_audio.py` → `scripts/seed_quote_audio.py`（上传 + 写 `audio_cache`，**不走 seed_audio 云函数**）；播放复用 `audio.js` 的 `playSentence` |
| 每日一句语料 | `miniprogram/utils/quotes.js`（静态、按日取模轮换，零后端；`utils/mock.js` 的 `DAILY_LINES` 与此同源） |
| 词表来源 / 筛选 / 归一 | `scripts/build_wordlist.py`（ECDICT → `assets/word_lists/ielts-full.json`；基础词排除 + 专名剔除 + 名词复数归一，规则全部固化为脚本常量） |
| **形似词（易混词）** | `scripts/gen_similar.py`（编辑距离算法 → `ielts-full-similar.json`）→ `scripts/seed_similar.py`（写入 `words.similar`，幂等）→ `miniprogram/pages/learn/learn.wxml`（展示）/ `learn.js`（`warmCard` 预载 + `playSimilar`）。**云函数零改动**，详见 §11.11 |
| 词表导入入参打包 | `scripts/pack_words.py` → `build/seed_words/batch-*.json` |
| 音频入参打包 | `scripts/pack_audio.py` → `build/seed_audio/` 或 `build/seed_sentence/` |
| 分享标题/路径/配图 | `miniprogram/utils/share.js`（`toFriend`），各页 `onShareAppMessage()` |
| 状态机流转 | `cloudfunctions/today_flow` + `submit_answer` + `finish_checkin` |
| **错题本「已掌握」（移出错题本）** | `cloudfunctions/dismiss_wrong/index.js`（给 `records` 打 `mastered` 标）+ `stats/index.js`（错题查询排除 `mastered:true`）+ `pages/wrongbook/wrongbook.js`（`markMastered`，乐观移除 + 失败回滚） |
| 页面跳转 | 各 `pages/*/index.js`（`wx.navigateTo`） |

---

## 11. UX 优化轮 · 施工与决策留档（2026-09-28 ~ 09-30）

> 本轮的两份原始施工单（`tasks-ux-miniprogram.md` 的 M0–M19 前端清单、`tasks-ux-backend.md` 的 T1–T6 后端清单）已**提炼成本节并删除原文件**；一次性开工提示词 `prompt-restore-ui.md` 也已删除（其「铁律」已固化为 `prototype-to-miniprogram` 技能）。
> 本节只留 **结论 + 落点**：决策最后选了什么、每项落在哪个文件/函数。**过程细节、踩坑经过、负向验证**在 §12。
> 视觉基准：`design/prototype.html`（8 页可点原型）+ `design/tokens.html`（token 对照）。换算口径：**rpx ÷ 2 = px**（原型按 375px 宽做的）。

### 11.1 决策的最终结论（D1–D11）

| 编号 | 问题 | **最终选择** | 影响 / 备注 |
|---|---|---|---|
| **D1** | 加练「再学一组」的显示条件 | **A：仅当日已打卡后显示** | 加练与主流程状态机彻底解耦，接口只需校验「今日已打卡」 |
| **D2** | 每组词数 | **沿用 `user.dailyGoal`（5 / 10）** | 余量不足一组即 `exhausted` |
| **D3** | 加练是否计入 `totalLearned` | **计入**（09-29 由「不计入」**反转**） | **结算时按整组入账**，口径与 `finish_checkin` 对称；幂等分支` stage==='done'` 不重复累加 |
| **D4** | 每日一句的实现路径 | **A：纯前端静态 `utils/quotes.js`** | 后端方案 B（云函数 `daily_line`）**已废弃且从未实现**。⚠️ 若在 `config.FN` 里看到该名字，也没有对应云函数 |
| **D5** | 底部 tab 栏路线 | **A：原生 tabBar** | 4 个 tab：首页 / 统计 / 错题本 / 我的。`switchTab` **不支持 URL 参数**（当前三页无带参需求，将来加筛选会被挡住） |
| **D6** | 练习页推进方式 | **A：保持自动**（`setTimeout(next, 900)`） | 原型里的手动「下一题」按钮**不落地**，那是原型的超纲改动 |
| **D7** | 加练按钮显隐（前端） | 同 D1 | 最终优先级见 §11.3 |
| **D8** | 统计页日历是否可点 | **暂不做** | 要做需**新增**「按日查询」接口，未立项 |
| **D9** | 错题本「错 N 次」badge | **暂不做** | 需 `user_words` 新增错误次数字段 |
| **D10** | `app.json` 导航标题改不改 | **必须改**（合规，非可选项） | 已落地 |
| **D11** | 引导页承诺行是否做成真入口 | **暂不做**，信息条整条保持不可点 | 要做需先确认「onboarding 未完成时允许进『我的』」这一状态合法 |
| **D12** | 学习页展示「形似词」（2026-10-22） | **离线预计算写 `words.similar`，最多 3 条；点喇叭发音、不跳卡** | 云函数零改动（`word_card` 整 doc 透传）；算法/覆盖率/落点见 §11.11；约 8.5% 词库内无形似词 → 「暂缺」 |
| **D13** | 形似词是否折叠（2026-10-22） | **默认收起**，点标题行切换；收起态露「N 个」计数 | 学习页五卡纵向堆叠，展开态约占屏 1/4；翻词不重置（用户收起就一路收起）；暂缺态不参与折叠（无可点暗示） |
| **D14** | 复习链路文案（2026-10-22） | **去掉时间断言**：练习页「复习单词」/ 首页「先复习一下」 | 「昨日」（§12.17）与「到期」（§12.14）都不准——复习池是在池未出池的词，正常日子也只是昨日新词的子集；模糊表述是唯一永远正确的，见 §12.19 |
| **D15** | 练习页题干区加词根拆解（2026-10-22） | **仅 cn_option 展示**（题干 = 单词 → 音标 → 词根 → 选项）；数据走 `build_questions.toClient()` 下发 `roots` | en_option 题干是中文释义，露词根=给选项送答案；旧队列无 `roots` → 兜底 `[]` 不渲染；需部署 build_questions，见 §12.20 |

### 11.2 M 清单（前端）落地结果

| 编号 | 内容 | 状态 | 落点 / 备注 |
|---|---|---|---|
| **M0** | 合规：文案里的「雅思」（9 处用户可见） | ✅ | `app.json` + `pages/index/index.json` 的导航标题、7 页 `onShareAppMessage` 文案、`utils/share.js` 兜底文案。`grep -rn "雅思" miniprogram/` 现为 **0 命中** |
| **M1** | 图标落地 | ✅ **实现方式与原计划不同** | ① **喇叭**：原型的内联 `<svg>` 在 wxml 里不能用 → 落地做成 CSS `background-image: url("data:image/svg+xml,…")`（`app.wxss` 的 `.speaker-icon`，<1KB、全站复用、色固定 `--primary`）。只一个图标，用 iconfont 属杀鸡用牛刀。② **tab 图标**：8 张 PNG 由 `scripts/gen_tab_icons.py` **纯 Python 光栅化**生成（⛔ **不要用无头 Chrome**——会抢占常驻实例导致卡死），落 `miniprogram/images/` |
| **M2** | 触控热区：8 处小于 88rpx | ✅ | `.speaker` 统一 **88rpx** 热区，视觉圆尺寸由各页 `.speaker-icon` 覆盖——**视觉不变、只扩热区**，是所有小图标的通用解法（统计页日历同理：热区挂外层 88rpx 的 `.cal-cell`，视觉圆点仍 60rpx） |
| **M3** | 底部固定区规范 | ✅ | `app.wxss` 的 `.bottombar`。**三条硬约束**：① 加了固定底部就**必须**给 `.page` 加对应 `padding-bottom`（**本项目最高频的落地错**，表现是「最后一块内容消失、滚到底也看不见」）② `env(safe-area-inset-bottom)` 不能省 ③ 原生 tabBar 下固定区要让出 tabBar 高度，**该高度不可写死** |
| **M4** | 首页：CTA + 加练固定底部 | ✅ | `pages/index/*`。`buildCta()` 的四态状态机**未改动**，加练按钮是**并列**的第二个按钮，不参与 CTA 状态机 |
| **M5** | 底部 tab 栏 | ✅ 走 D5=A | `app.json` 的 `tabBar` + `miniprogram/images/tab-*.png`。路由约定：指向 tab 页一律 `switchTab`、离开 tab 页 `reLaunch`；tab 页停播挂 `onHide`；**tab 页视口不含 tabBar** |
| **M6** | 学习页：底部固定 + 分段进度 | ✅ | `pages/learn/*`。「下一个」移出文档流；分段进度（N 词 N 段）；`next()` 保留**逐词推进**语义（**别「简化」成直接跳练习**） |
| **M7** | 练习页 | ✅（推进方式取 D6=A） | 喇叭图标替换；**答错可重选、答对才推进**的原逻辑保真；新增 `round` 参数路由到加练队列（缺 `round` 会覆盖主队列，见 §11.5 C4） |
| **M8** | 打卡页：分享按钮降权 | ✅ | `checkin.wxss` 的 `.share-btn` 改次级规格。`open-type="share"` 本身无需改动 |
| **M9** | 统计页日历可点 / 卡片下方留白 | ⛔ **未做**（D8 暂不做） | 日历网格算法在 `stats.js`（`cells` 由月份首日星期几算前导空格），**改动时不要重写**——原型是复刻它的 |
| **M10-1** | 错题本卡片整块可点 | ✅ **且行为已改** | W2 后整卡 `bindtap` 从「发音」改为「**进学习页复习**」；喇叭改独立 `catchtap`（父热区换行为后，发音必须自己有热区）→ 本页热区 = 1 父 + 2 个 `catchtap` 子 |
| **M10-2** | 错题本底部「再练一遍」出口 | ⛔ **未做，但前置已解除** | 当初卡在「等 T1」（怕照原型实现会覆盖主练习队列 = §11.5 C4）；**T1 已落地，`round` 通道就绪，现在可以直接接** |
| **M11** | 错题本「错 N 次」badge | ⛔ **未做**（D9 暂不做） | 同上需新字段 |
| **M12** | 每日一句（首页） | ✅ | `utils/quotes.js` 静态语料，按日取模轮换（`dayIndex = floor(Date.UTC(y,m,d)/86400000) % len`），**零后端**。⚠️ 原计划「落地时扩到 100 句」，**实际保留 12 句**（12/12 音频已入库）；扩句必须同步跑音频三步，见 §7.8 |
| **M13** | 首页「再学一组」 | ✅ | 见 §11.3（显隐优先级是踩过坑之后的最终版） |
| **M14** | 引导页（拇指区 + 版面填空） | ✅ | 主操作固定底部；新增品牌区（`.ob-mark` + 品牌名 + 「2987 个核心词 · 例句带发音」）、选项预计时长 + 「推荐」标、信息条。**品牌区与信息条不可点、不进热区审计**。⚠️ 文案**不得出现「雅思」**与 AI 相关展示（提审要求） |
| **M15** | 可读性 token | ✅ | `app.wxss`：`--text-2` → `#616770`、`--text-3` → `#7f8691`、新增 `--success-deep` `#0f6b4f`。**用法约定比色值更重要**：`--text-3` 只做装饰（分隔符/占位图形），承载信息的文字一律 `--text-2`；绿字与绿底白字一律 `--success-deep`，`--success` 只留给描边与图标 |
| **M16** | 引导页文案区拆解 | ✅ | 副标题只留「目标要小到不会放弃」；信息条拆**两行**（一行一件事），第 2 行补出落点「之后可以随时在「我的」里修改」——把空承诺变成指明去处 |
| **M17** | 字号下限 | ✅ | tab 标签 / 星期字 / 指标名 / 词根标 11px → **12px**；胶囊标（tag / badge）保留 11px（审核里唯一剩下的 INFO，属有意保留） |
| **M18** | 连点防护 | ✅ | 学习页 `next()` 加 `locked`；⚠️ **打卡不用改**——`finish_checkin` 已按 `_openid + date` 幂等，前端 `wx:if="{{loading}}"` 也挡了 |
| **M19** | 反馈载体与安全区 | ✅ | ① **有固定底栏的页禁用 `wx.showToast`**（位置不可控，会被按钮压住）→ 错题本改用自绘顶部提示条 `errTip` ② 每个固定底部区都要避让 Home 条；**tab 栏形态的避让要写在外壳上**，只写在 `.tabbar` 里无效 ③ 可点元素要有按压反馈：小程序**没有 `:active`**，`<button>` 用原生 `hover-class`，`<view>` 自加 `.hover` 并在 `touchstart/touchend` 切换 |

### 11.3 M13 加练按钮的显隐优先级（踩坑后的最终版）

`miniprogram/pages/index/index.js` 的 `buildExtra()`：

| 序 | 条件 | 表现 |
|---|---|---|
| 1 | 未打卡 | 隐藏（D1=A，本就不该有） |
| 2 | 云端未返回 `extra`（旧版 `today_flow`） | **乐观显示**，绝不静默隐藏 |
| 3 | **`pendingRound` 非空**（有未完成的组） | **显示 + 可点**，文案「继续学一组」 |
| 4 | `exhausted` | 显示 + 置灰 + 底栏「预置发音的词已学完…」 |
| 5 | `limitReached` | 显示 + 置灰 + 底栏「今日加练已达上限，明天可继续」 |
| 6 | 正常 | 显示 + 可点「再学一组」 |

- ⚠️ **第 3 条必须排在 `limitReached` 之前**。曾经写成「先判上限就隐藏」，导致用户建满 3 组后中途退出、首页按钮消失，**手里那组永远进不去**（云端 `canStart` 明明是 `true`）。症状是「刚才还能再学一组，现在不行了」，**极易误判成后端没部署**。回归：`scripts/test_index.js`
- ⚠️ 第 4/5 条**从「整个隐藏」改成「置灰 + 说明原因」**，是对原 M13 设计的**有意偏离**：按钮凭空消失正是那次报障的观感，把原因写在底栏比静默消失好排查
- `limitReached` 现已**恒为 `false`**（上限于 09-29 取消，不限次数），这一行是**防御性保留**——防止将来云函数加回上限时前端又「静默隐藏」

### 11.4 T 清单（后端）落地结果

| 编号 | 内容 | 状态 | 落点 / 备注 |
|---|---|---|---|
| **T1** | 再学一组（加练） | ✅ | 新增 `start_extra_round` / `finish_extra_round`；改造 `today_flow`（返回 `extra` + `markLearned(round)`）、`build_questions` / `submit_answer`（`round` 路由）、`home_summary`（`extraLearnedToday`）。契约见 §5，业务说明见 §7 |
| **T2** | 每日一句（云函数 `daily_line`） | ⛔ **不做**（D4 选 A） | 方案 B 的规格已随施工单删除；**`daily_line` 从未实现** |
| **T3** | 底部 tab 栏 | ✅ 纯前端 | 见 M5 |
| **T4** | 配套改动（索引 / 部署 / 文档同步） | ✅ | `assets/db-indexes.json` **无需改**（加练组内嵌，未新增索引）；`docs/deploy.md` 云函数数 15 → 18；`miniprogram/config.js` 的 `FN` 加两个常量；`utils/api.js` 加 `startExtraRound()` / `finishExtraRound()` |
| **T5-0** | 打卡幂等 | ✅ **核实无需改**（结论留档） | `finish_checkin` 按 `_openid + date` 查重，命中直接返 `{already:true}` 且不累加。⚠️ 当时**错的是原型**（没复刻 `already` 语义，演示出一个真机不存在的「重复打卡」缺陷），已修 |
| **T5-1** | `submit_answer` 缺幂等 | ⛔ **仍未做**（风险已下降，见 §11.8） | 现状 `records.add(...)` 无条件插入 → 连点 / 网络重试会在 `records` 落**多条同题记录**，污染正确率统计与 `nextReviewDate`。**2026-10-12 起前端已显著收窄触发面**：判题改本地后不再有「等回包才好点下一下」的窗口，同题只有未被禁用的选项能提交，且所有提交串行化 + 失败重试一次（重试本身是幂等风险点 —— 第一次其实成功了但回包丢了就会重试出第二条）。**根因仍在云函数**，建议幂等键 `_openid + planId + questionId`，或在 `records` 上建唯一索引 |
| **T5-2** | 每日目标修改的生效时点（文案与行为不一致） | ⛔ **仍未做** | 文案写「从下一个自然日生效」，但当天**还没开始学习**就改 → 当天立刻按新目标出词，**文案不成立**。选项 A 改文案（便宜）/ **B 把 `dailyGoal` 快照进 `plan`**（更准，顺带让历史计划的词数不再随目标漂移） |
| **T6** | 错题本「已掌握」（用户追加，非原型项） | ✅ | 新增 `dismiss_wrong`（给 `records` 打 `mastered`）+ `stats` 查询排除 `mastered`。语义是**打标过滤而非删除**（防流水污染正确率 + 让「再答错自动复活」零成本），故**不做撤销、不做回收站**。取舍见 §4.5、踩坑见 §12.10 |

### 11.5 T1 的四个技术冲突（加练的核心难点，改这块前必读）

| # | 冲突 | 现状证据 | 对策 |
|---|---|---|---|
| **C1** | `daily_plans` 唯一索引 `_openid + date` → **一天只能一条 plan** | `assets/db-indexes.json` | 加练组**内嵌**为 `plan.extraRounds[]`，不另建文档、不改索引 |
| **C2** | `finish_checkin` 用 `plan.newWordIds` 算 `learnedCount` 并推进 `wordCursor` | `finish_checkin/index.js` | 加练词**绝不写入** `newWordIds`，独立字段存放 |
| **C3** | `submit_answer` 在练习全对时**无条件**写 `plan.stage` | `submit_answer/index.js` | 加练答题必须带 `round`，**仅 `round === 0` 才改 `plan.stage`** |
| **C4** | 队列存在 plan **顶层**字段，加练复用会覆盖当日主练习 | `build_questions` / `submit_answer` | 加练队列存 `extraRounds[i].practiceQueue`，靠 `round` 参数路由 |

> **C4 是最容易踩的坑**：不加 `round` 隔离，加练的 `build_questions` 会**直接覆盖**当日主练习的 `practiceQueue`，用户重进练习页看到的是加练题——主流程被**静默**破坏，而且因为读写的是同一字段，排查时极难定位。
> **总原则**：加练是主流程之外的旁路，**绝不触碰** `plan.stage` / `newWordIds` / `checkins` / `streak` 这四样主流程资产。

### 11.6 本轮新增的回归脚本（改相关逻辑必跑）

> 🐶 **看门狗**：`_harness.js` 的 `tester()` 带 8s 看门狗 —— 断言串在一条 await 链上，
> 任一处**卡在永不回包的 promise**时 node 会**静默退出且退出码 0**（看起来像通过）。
> 实测踩过一次（把判题改回「等云函数」，`test_practice` 挂在 await 上、输出戛然而止却报成功）。
> 新增页面测试请一律用 `tester()`，别自己写断言计数器。

| 脚本 | 覆盖 |
|---|---|
| `scripts/audit_mobile.js` | 移动端体验审核，口径 16 项（热区 ≥44px / 热区压盖 / 相邻间距 / **选项组落点 THUMB_LOW** / **选项组未贴底 THUMB_GAP** / **题答断层死白 GAP_DEAD** / 字号 / 对比度 WCAG AA / 行高 / 截断 / 横向溢出 / 主操作拇指区 / toast 遮挡 / 安全区 / 可达性 / 连点） |
| `scripts/check_miniprogram.js` | 结构自检：类名 / 底栏三件套 / 图标 / wxml 配对 / **云函数三件套** / `config.FN` ↔ 目录一致性 / **练习页「上题下答」布局契约（⑦）** |
| `scripts/test_learn.js` | 学习页三模式：错题复习 / 今日新词 / 加练；**卡片预取窗口 + 音频预加载** |
| `scripts/test_index.js` | 首页加练按钮显隐 + 朋友圈单页模式降级 + **每日一句预加载** |
| `scripts/test_practice.js` | 练习页：**本地同步判题（不等落库回包）+ 后台串行落库 + 跳转前 flush + 落库失败重试/提示** + 降级路径（题不带答案时回退服务端判题） + **两种题型的预加载字段选择** + 三种出口（打卡 / 学习页 / 加练结算） |
| `scripts/test_build_questions.js` | 云函数契约（**判题契约的产生处**）：`answerIndex` / `audioText` 真的下发了、指向的是正确答案、`audioText` **绝不含中文**（判据是 `type` 不是 `phonetic`）、**复用分支同样带答案**、round 路由 |
| `scripts/test_audio.js` | 音频链路：**本地文件缓存（首播/再播/跨启动/被回收）+ 预加载队列（并发/去重）+ LRU 淘汰** + `cloud://` → 临时链接转换 / 透传 / 降级 |
| `scripts/test_wrongbook.js` | 错题本：点词进复习 / 已掌握 / 失败回滚 / **错词整表预加载** |
| `scripts/test_finish_extra_round.js`、`test_start_extra_round.js` | 云函数逻辑无头测试（桩 `wx-server-sdk` + 内存假 DB，直跑真实 `index.js`） |
| `scripts/test_mock.js` | mock 层（数据口径 + 每日一句体检） |
| `scripts/test_prototype.js` | 原型业务流程回归（⚠️ 只审 `design/prototype.html`；**当前 33/4 为既有失败**，与真机改动无关，见下方警告） |

> ⚠️ **原型 ≠ 真机**：`audit_mobile.js` 与 `test_prototype.js` **只审 `design/prototype.html`，对 `miniprogram/` 零验证力**。
> 原型里有 4 处**演示性超纲改动**（练习页手动按钮 = D6、日历可点 = D8、错 N 次 badge = D9、打卡连点其实已幂等），照着还原会写出与真机不符的逻辑。**落地前必须回源码核一遍真实行为**——本项目已因此误判过一次（把原型的「重复打卡」当成真机缺陷报了出来）。

### 11.7 发声延迟优化（2026-10-08，封版 v1.0 后的一轮）

**用户报障**：「调用语音时有延迟，多次跳转到下一个页面后才出来读音」。

**归因**（一条链路上有四种等待同时存在）：
1. `audio_cache` 云函数**冷启动**（数百 ms ~ 秒级）；
2. `getTempFileURL` 换链接；
3. 音频文件**每次都要重新下载**（前端只缓存了 fileID，没缓存音频本身）；
4. learn 页**只预取下一张卡**，且预取在「第 1 张卡回来之后」才发生 → 本质是串行。

**决策与落地**：

| # | 决策 | 理由 |
|---|---|---|
| P1 | 音频落到**本地文件**（`USER_DATA_PATH/audio/`），storage 只存指针 | 前端缓存 fileID 挡不住「每次都要下载」这一层 |
| P2 | **先出声、后台落盘**，而不是「落盘完再播」 | 反过来会让首播比旧版更慢；实测首播持平、次播起才吃到收益 |
| P3 | 新增 `preloadWords` / `preloadSentences`，**统一队列**（并发 3 + 同批去重 + `pending` 合并并发请求） | 4 个有声页面各排各的会互相抢带宽 |
| P4 | learn 页 `PREFETCH_AHEAD = 3`，**开页即预取窗口** | 关键不是「取几张」而是**并行**：后 2 张要与第 1 张同时出发 |
| P5 | `warmup()` 在 app 启动空调一次 `audio_cache`（空 text，不写库不外呼） | 冷启动是大头，挪到启动阶段最划算 |
| P6 | 本地上限 **50MB + LRU** | 官方上限 200MB（本地缓存文件 + 本地用户文件合计）且**超了直接写失败、平台不自动清理** |
| P7 | 例句**不**预加载「逐词」，只预加载整句 | 与 7.9 的整句音频一致；整句无音频时静默，与旧行为相同 |

**踩到/绕开的三处**：
- ⚠️ **不要在冷启动时 `accessSync` 全扫索引**：同步 JSBridge ×几百条会把「第一次点喇叭」卡住上百毫秒 —— 正是要消灭的等待。改为按需精确清理（记录侧 `exists` 失败 → `indexDrop`；淘汰时 unlink 失败 → 该行本就是脏的）。`test_audio.js` L1 用「检查次数与索引长度无关」钉死。
- ⚠️ **测试桩里的下载必须异步回包**：`wx.downloadFile` / `cloud.downloadFile` 桩若同步 resolve，`m.local` 会在播放分支之前就绪，测出来的是本地路径而真机是远端流 —— P2 的断言会假红/假绿。已在 `test_audio.js` 里写明原因。
- ⚠️ **预取失败不能缓存**：`cardCache[i]` 存的是 promise，失败后必须 `delete`，否则那张卡永远白屏。这条不走整页流程断言（失败与 `loadCard` 的先后落在微任务顺序里，会变成脆测试），直接对 `prefetch()` 下断言。

**本次不需要部署任何云函数**（纯前端 + 不改 `audio_cache` 契约）。新增回归：`scripts/test_practice.js`（21 条）；`test_audio.js` 重写为 46 条；`test_learn` 47 条、`test_index` 27 条、`test_wrongbook` 22 条。全部断言做过**负向验证**（禁用本地优先 / 不认 storage 指针 / 取消后台落盘 / 放开并发 / 恢复索引扫描 / 练习页改拿 stem → 均能判红）。

### 11.8 选择题改为「本地同步判题」（2026-10-12，封版 v1.0 后的一轮）

**用户报障**：「选择题是在线比对正确和错误吗？改成答案同步返回，不需要时间去查数据库」。

**归因**（原链路把「判对错」和「记流水」绑成了一件事）：点选项 → `submit_answer` → 云端**查 `daily_plans` 取题 → 查 `words` 取词 → 判题 → 写 3 张表 → 返回 `correct`**。
也就是说**出对错必须等一次完整云函数往返**（冷启动时数百 ms~秒级），而答案本来就在服务端题目里、下发前被 `sanitize()` 剔掉了 —— 是白等的。

**决策与落地**：

| # | 决策 | 理由 |
|---|---|---|
| Q1 | `build_questions.toClient()` **随题下发** `answerIndex` | 判题所需信息在前端手里，往返没有存在价值 |
| Q2 | 另下发 `audioText`（答对后要读的英文），**判据用 `type`** | 不能拿 `phonetic` 是否为空来推 —— 没音标的 cn_option 会推成中文释义（前端拿去查音频必落空）。顺手修掉了 `preloadAll` 里同源的旧判据 |
| Q3 | `submit_answer` **不退场**，退化为后台落库；前端**不 await** | 正确率 / 错题本 / 复习调度 / `stage` 全靠它写，去掉等于砍掉半个后端 |
| Q4 | 提交走**一条 Promise 链串行**（`syncAnswer`） | 它是「读整个 queue → 改 → 写回整个 queue」，并发提交互相覆盖（后写的抹掉先写的 `passed/wrong`） |
| Q5 | 终点分支先 `await flushSync()` 再跳转 | `finish_checkin` 的前置是「queue 全 passed」，而 passed 由 `submit_answer` 写 —— 不等就是「题全答对了，打卡却提示没做完」 |
| Q6 | 落库失败「重试一次 → 仍失败则明确提示」（每页只提示一次） | 判题已在本地完成，落库静默失败 = 数据静默缺口；每答一题弹一次会刷屏 |
| Q7 | 保留**降级路径**：题目不带 `answerIndex` 时回退「等服务端判题」 | 前端先发布、云函数忘部署时，缺答案会把每个选项逐个判错并禁掉 → 用户**卡死**。宁可慢，不能死 |

**踩到/绕开的两处**：
- ⚠️ **测试卡在永不回包的 promise 上会「静默成功」**：node 事件循环空了就退出、**退出码 0**，后面的断言一条不跑，CI 看到的是通过。做负向验证时实测踩到（把判题改回等云函数 → `test_practice` 挂在 `await` 上、输出戛然而止却报成功）。已在 `_harness.js` 的 `tester()` 里加 **8s 看门狗**（用 `timers.setTimeout`，因为页面测试会把 `global.setTimeout` 压短）—— 这条对所有页面测试生效。
- ⚠️ **`plan.practiceQueue` 与前端下发是两条路径**：答案现在故意下发给了练习页，但 `today_flow` 下发的 `plan.extraRounds` **仍要剥掉 `practiceQueue`**（§5 第 3 行）。别因为「反正答案已经下发了」就把这条剥离线删掉 —— 那会把每天的整份题连带答案铺给首页。

**回归与负向验证**：
- 新增 `scripts/test_build_questions.js`（**25 条**，云函数判题契约）；`test_practice.js` 从 21 条重写为 **37 条**。其余全绿：`test_learn` 47 / `test_index` 27 / `test_wrongbook` 22 / `test_audio` 46 / `test_mock` 23 / `test_finish_extra_round` 21 / `test_start_extra_round` 21 / `check_miniprogram` 通过。
- **负向验证**：`practice.js` 9 条改坏点 + `build_questions` 6 条改坏点，全部能判红、0 漏网（判题恒真 / 不落库 / 不串行 / 取消 flush / 失败不提示 / 判据退回看 phonetic / 永远走降级 / 不重试 / 去掉在途锁 / 不下发答案 / 复用分支偷偷剔答案 / round 路由回主队列）。
- ⚠️ `test_prototype.js` 当前 33 passed / **4 failed**，在 `v1.0` 基线（`git archive HEAD` 干净副本）上**同样 4 failed** —— 是原型页既有问题，与本次改动无关，别误判成回归。

**⚠️ 本次必须部署 `build_questions`**（`python3 scripts/deploy_functions.py` 会自动识别）。不部署则前端静默走降级路径：行为正确、延迟照旧 —— 这种「改了个寂寞」的失败没有报错，只能靠 `test_build_questions.js` 和真机体感发现。

### 11.9 选择题选项的「单手可达」改造（2026-10-12，同一轮）

> ⚠️ **本节只解决了「落点」，其「选项区 `flex:1` + 贴底」的写法已在 §11.10 被取代**（那版把剩余高度全堆成题答之间的死白）。
> 练习页布局的最终结论以 **§11.10** 为准；本节保留作为「为什么先想到贴底」的过程记录。

**用户报障**：「选择题选项的 UI 做一下优化，现在单手操作不好点」。

**归因（量化，不靠手感）**：把练习页放进 375×720 真机框量了一遍 —— 旧版**最低一项的下沿只到屏高 66%、整组中心在 49%**，而屏幕下半区约 240px 完全空着。整组选项落在「要伸手够」的中上部。关键在于**热区本身并不小**（每项 56px ≥ 44px 下限），所以 `audit_mobile` 原有的 `HIT_SMALL` 照不到它：这是**落点**问题，不是尺寸问题。

**分两轮压到底**（同一轮里的迭代）：
- **第一轮**（用户：「UI 做一下优化」）先把整组从屏上部**拉进下半区**：整页 flex 纵向拉伸 + `.options { flex:1; justify-content:center }` → 中心 58% / 下沿 77%。
- **第二轮**（用户：「① 把选项再往下压」）改成**贴底** `.options { justify-content:flex-end }` → 中心 61% / 下沿 80%、**下沿空档 26px**。

为什么最终按「**离屏幕底部的距离**」而不是「屏高比例」对齐：拇指舒适区取决于**手指到手机下沿的物理距离**，与屏幕多高无关。按比例居中时屏越高越够不着；贴底后下沿离屏底的距离**恒定**（= 反馈文案 + 安全区 + 20px 留白），不随屏高漂。代价是题干卡片与选项之间的留白变多 —— 有意为之，拇指舒适优先。

**三处叠加的改动**（缺一个效果就打折，负向验证时必须按「完整旧版」构造，见下）：

| 改动 | 位置 | 为什么 |
|---|---|---|
| 整页 flex 纵向拉伸；`.options` 用 `flex:1` 吃掉题干以下的剩余高度，选项在其中 `justify-content: flex-end`（**贴底**） | 两边 wxss / prototype css | 让选项整体落在屏幕下半区、且下沿离屏底距离恒定；小屏挤在下半区、大屏不再往下漂 |
| `.option` `min-height: 120rpx`（60px）+ `gap: 24rpx` | 同上 | 单项更高，整组也更高，把下沿进一步压到屏高 80% |
| 题干卡片固定 `min-height: 240rpx` | 同上 | 题干从一行英文到两行中文，卡片高度一变选项就整体挪位 —— 手指每次要重新找目标 |

量化（375×720，数值在 `build/audit-mobile.json` 的 `pages[].options`；`gapBelow` = 选项组下沿到选项区可用空间底部的空档，贴底趋近 0）：

| | 选项组中心 | 下沿 | 下沿空档 | 单项高 |
|---|---|---|---|---|
| 旧版（整屏顶对齐） | 屏高 49% | 66% | — | 56px |
| 第一轮（居中） | 58% | 77% | — | 60px |
| 第二轮（贴底） | 61% | 80% | 26px | 60px |
| 第三代（贴底 + 题干撑满，见 §11.10） | 71% | 92% | 26px | 66px |

**决策留档**：
- **Q1（已推翻重定）先「居中」后改「贴底」**：第一轮用 `justify-content:center` 是为了避开「贴底会和反馈文案挤在一起」的顾虑；用户要求「再往下压」后改为 `flex-end`，顾虑用**下沿 padding `24rpx 0 40rpx`**（20px 留白 + 安全区）解决 —— 反馈文案仍恒占位、不被压住。落地以**贴底**为准。
- **Q2 反馈文案改成恒占位**（`wx:if` → 三目 + `min-height`）：答对/答错文案出现时会推挤上面的选项，而答对后 900ms 自动跳转 —— 这一推挤恰好发生在手指准备落下的时刻。
- **Q3 题干中文降一档字号**（`.q-stem.zh` 46rpx → 40rpx）：en_option 的题干是中文释义，46rpx 下三四个字就折行抢空间；降档后仍明显大于选项正文（32rpx），层级不丢。

**顺手修掉一个真 bug：答错后的「已排除」项在界面上看不出来。**
`choose()` 答错会把该选项记进 `disabled`，之后点它直接 `return` —— 但 wxml 的 class 从头到尾没用过 `disabled`，于是这个选项**外观与正常选项完全一样，点下去毫无反应**，而用户此刻的动作恰恰是「手指停在原位置再点一次」（本项目高频坑：静默失败）。现在加 `off` 态（灰度 + 字母位换 `✕`）；CSS 顺序刻意让 `.option.bad` 覆盖 `.option.off`，所以「刚答错的那一项」仍是红的（它同时是 off+bad），只有改选之后失去 `bad` 的旧错项退回灰轮廓。原型 `choose()` 同步（原来是所有错项永久留红）。同时把选项的按压反馈从全局 `hover-dim`（只降透明度）换成页面级 `.hover-opt`（浅蓝底 + 描边），并设 `hover-start-time="0"` / `hover-stay-time="100"` —— 按下立即亮、抬手很快复原。

**给这次改动补了两道自动保护**（此前一道都没有：`audit_mobile` 只审原型、`check_miniprogram` 不碰样式语义）：
1. `audit_mobile.js` 新增 **`THUMB_LOW`**（选项组中心 < 屏高 **55%** 或下沿 < **75%**）+ **`THUMB_GAP`**（下沿空档 > 40px ⇒ 没贴底）+ `OPTION_OFFSCREEN`，几何（中心/下沿/空档/单项高）写进 `build/audit-mobile.json` 便于长期观察
2. `check_miniprogram.js` 新增 **⑦ 练习页选项落点契约**：`.options` 必须 `flex:1` **且 `justify-content: flex-end`（贴底，不只是撑满）**、`.option` 的 `min-height` ≥ 88rpx、答错态必须**既有 wxml 的 `off` 类、又有 wxss 的 `.option.off` 样式**（光有类名不算数 —— 那正是这次的 bug 形态）
   > ⚠️ 这条契约在 §11.10 已被**改写**：`.options` 现在**不许**带 `flex:1`（剩余高度归题干区）。见 §11.10。

> ⚠️ **阈值 55/75 是收紧过的**：最初定 50/70，而「顶对齐」变体实测中心 52% / 下沿 71% **刚好溜过**（假绿）。收紧到 55/75 后，当前贴底版（61/80）仍有 5–6pp 余量，同时能挡住居中版（58/77，虽过线但 `THUMB_GAP` 会兜住）。

**负向验证**（脚本 `/tmp/mut_push_down.py`；按**规则块**定位改动、用内存里的原文还原，共 8 条改坏点，**全部判红、0 漏网**）：
- 原型 3 条：`justify` 回退为居中 / 完整旧版（居中 + 下沿 4px）/ 整屏顶对齐 → 判红（后者中心 49% / 下沿 66%；居中版下沿空档 26→61px 被 `THUMB_GAP` 兜住）
- 小程序 5 条：`.options` 回退为居中 / 干脆不写 `justify-content` / 丢掉 `flex:1` / `min-height` 降到 80rpx / 删掉 `.option.off` 样式 → 全部判红
- 过程记录（两个坑）：① 第一次只把「选项区不撑开」单独改回去 → 中心仍有 52%、下沿 71%，**没判红**。这不是假绿，而是说明落点改善是**三处叠加**的结果，单去一处仍在下半区 —— 负向验证必须按「完整旧版 / 完整居中版」构造。② 源码注释里也写了 `justify-content: flex-end`（正文讲决策），直接 `replace(...,1)` 会改到注释而规则没动 → 假「漏网」；故一律**按规则块定位**。️另外**别拿 `git checkout` 当还原手段**（会连同未提交改动一起抹掉，本轮踩过一次，靠会话中读到的原文重建）。

**回归**：`test_practice` 37 / `test_learn` 47 / `test_index` 27 / `test_wrongbook` 22 / `test_audio` 46 / `test_mock` 23 / `test_build_questions` 25 / 两个 extra_round 各 21 / `check_miniprogram` 通过；`audit_mobile` **P0/P1/P2 全 0**（仅 10 条 `FONT_SMALL` INFO）。**本次不需要部署任何云函数**（纯前端 wxml/wxss + 原型 + 脚本）。
复核方式：真机框逐版对比图见 `build/practice-options-thumb.png`（居中版 vs 贴底版，375×720 iframe 实测；更早的 px 对比见 `build/practice-options-ux.png`）。两图都在 `build/`（已 gitignore）。

### 11.10 练习页「上题下答」布局 —— 空白分配（2026-10-12，承接 §11.9，**结论以本节为准**）

**用户报障**：「① 把选项再往下压 这个要走一下 UI 优化，不是直接往下放就行了，要有整体的布局规划，现在选项上方留了太多的空白，**先是整体的美观，再是用户体验**」。

**归因（量化，先看实拍再动手）**：§11.9 的「选项区 `flex:1` + 贴底」只解决了**落点**，却把**所有剩余高度**都堆到了「题干卡 ↔ 第一项」之间 —— 题干卡仍是内容高度（154px），选项区吃掉全部剩余高度。实测题答之间的空档：

| 视口 | 空档 | 说明 |
|---|---|---|
| 375×667 | **103px** | 小屏还不明显 |
| 375×720 | **156px** | 已是一整片死白 |
| 430×932 | **368px** | **屏越大越空** —— 这正是用户看到的问题 |

**关键认识**：这不是「留白多少」的问题，是**空白被堆在一处**。留白本身不丑，集中成一坨才丑。所以修法不是调参数，是**决定剩余高度归谁**。

**三代写法（差别只在「剩余高度归谁」，这是本页布局的唯一变量）**：

| 代 | 剩余高度归 | 落点 | 题答空档 | 结论 |
|---|---|---|---|---|
| ① 顶对齐 | 页面（不分配） | 下沿 66%（上半屏） | — | ❌ 单手够不到 |
| ② 选项区 `flex:1` + 贴底 | 选项区内部 | 下沿 92%／中心 71% | 103 / 156 / 368 | ❌ 落点对了，空白成灾 |
| ③ **题干区 `.q-card{flex:1}`** | **题干主视觉** | **下沿 92%／中心 71%** | **12 / 12 / 12** | ✅ 落点保持，空白变成呼吸空间 |

第③代的具体写法（三处，缺一不可）：

| 改动 | 位置 | 为什么 |
|---|---|---|
| `.q-card { flex: 1 1 auto }`（`min-height:240rpx` 只作小屏兜底） | `practice.wxss` / prototype | 题干区吃掉剩余高度 → 题答之间**恒定 12px**，不再随屏高堆积 |
| `.options { flex: 0 0 auto }`（保留 `justify-content: flex-end`） | 同上 | 选项区回到自然高度 + 贴底；**不能**再来抢剩余高度，否则空白只是换个位置 |
| `.option min-height: 132rpx`（66px）+ `gap: 28rpx` | 同上 | 下半区有分量，与题干主视觉形成节奏 |

**决策留档**：
- **Q1 剩余高度只给一处（题干区）**：`flex:1` 两处都写会「均分」——实测题答空档 32px、卡片变小，是小一号的旧毛病。契约里因此专门加了「`.options` 不许带 `flex:1`」这一条。
- **Q2 不做「整页内容垂直居中」/「上下均分」**：把 header 也拽到半空（实测卡片顶到 133px），或底部留一整条 145px 空带 —— 空白只是换了位置，依然不像设计过的页面。
- **Q3 不给题干卡加深色/彩色底**：试过 `--primary-soft` 大色块，**反而放大了空的感觉**（一大片蓝里挤着一行字）；白卡 + 大量留白读起来是「答题卡」，更像有意为之。
- **Q4 不放大题干字号**：字号体系（`tokens.html`）最大 h1=34rpx，题干 46rpx 已是**有意超纲的主视觉**；再往上就是自造档。

**新增两道自动保护**（此前 `THUMB_GAP` 只看「选项组下方」，看不到「题干与选项之间」——**只修一条会把空白从一处挪到另一处**，本轮就是这个形态）：
1. `audit_mobile.js` 新增 **`GAP_DEAD`**：题干区与选项组之间空档 > 48px 判红（几何 `gapAbove` 写进 `build/audit-mobile.json`）；口径 15 → **16 项**
2. `check_miniprogram.js` ⑦ 契约改写为「上题下答」三条：`.q-card` 必须有 `flex:1`、`.options` **不许**有 `flex:1`、`.options` 必须 `justify-content: flex-end`；并保留 `.option min-height ≥ 88rpx` 与答错态 `off` 双保险

**负向验证**（脚本 `/tmp/mut_layout.py`，按**规则块**定位、内存原文还原，**8/8 判红、0 漏网**）：
- 原型 3 条：退回上一版（卡内容高 + 选项 `flex:1`）→ `GAP_DEAD` 52px；只剩题干卡不撑 → `THUMB_LOW`+`THUMB_GAP`（空白落回屏底）；选项压扁到热区下限以下 → `HIT_SMALL`
- 小程序 5 条：题干卡丢 `flex:1` / 选项区加回 `flex:1` / 选项改居中 / `min-height` 降到 80rpx / 删 `.option.off` 样式 → 全部判红
- **两条有价值的「测不出来」**（不是假绿，是真实边界）：① 题干区撑满后，`.options` 的 `justify-content` 已变成**空操作**（选项区没有自由空间了），原型侧观测不到它 —— 所以这条只由源码级契约守住；② 只压 `.option` 的 `min-height` 到 44px 也不会判红，因为选项的**天然高度**（正文 24px + 内边距 20px）本就在 44px 上。

**回归**：page 测试全绿（practice 37 / learn 47 / index 27 / wrongbook 22 / audio 46 / mock 23 / build_questions 25 / 两个 extra_round 各 21）；`check_miniprogram` 通过；`audit_mobile` **P0/P1/P2 全 0**（仅 10 条 `FONT_SMALL` INFO），`s-practice` 几何 = 中心 59%／下沿 80%／`gapAbove` 12px／`gapBelow` 26px／单项 66px。**本次不需要部署任何云函数**（纯前端 wxml/wxss + 原型 + 脚本）。
对照图：`build/practice-layout-qa.png`（375×720 与 430×932 各一组前后对比，本地生成，`build/` 已 gitignore）。

### 11.11 形似词（2026-10-22，封版 v1.0 后的一轮）

**需求**：「库里的单词在学习的时候，把形似词也列出几个最多 3 个，单词/读音/翻译」。

**最终形态**：学习页「词根拆解」卡片之后新增「形似词」卡片，最多 3 行，每行 = 单词 + 音标 + 小喇叭 + 释义；点喇叭播该词发音（与主词同一链路）。**不跳卡**（D12）。**默认折叠**（D13）：学习页五个卡片纵向堆叠，展开态约占屏 1/4，故默认只露标题行 + 「N 个」计数，点标题行整行切换展开/收起（CSS 三角箭头旋转过渡），翻词不重置。楼层顺序：主卡 → 词根拆解 → **形似词** → 例句 → 单词演变（形似词初版在主卡之后，当天按用户要求把词根拆解提到它上面——先纵向拆解本词，再横向对比形似词，最后落到例句）。

**数据方案选型（为什么是离线预计算）**：

| 方案 | 判定 | 理由 |
|---|---|---|
| **离线预计算写 `words.similar`** | ✅ 采用 | 2987 词本地全量约 17s，一次算永久用；零运行时成本；确定性可复现；可人工抽检 |
| enrich_word AI 生成 | ❌ | 有幻觉风险（可能给出不在词表里的词，用户学不到）；2987 词成本不可控 |
| word_card 运行时计算 | ❌ | 每次翻页全表扫描 2987 词，冷启动延迟直接转嫁给发声体验 |

**算法**（规则固化为 `gen_similar.py` 常量，改参数即改行为）：

| 参数 | 取值 | 理由 |
|---|---|---|
| 候选范围 | 全库除自身；长度差 ≤ 3 | 形似词必须也在库里才构成学习闭环；长词要容纳 accommodate/accommodation 类形态变体 |
| 编辑距离上限 | 词长 <5 → 2；5–9 → 3；≥10 → 4（带状 Levenshtein，超限早退） | 短词差一个字母已差异明显；长词需更大容忍度 |
| 排序键 | (距离 ↑, 公共前缀 ↓, seq ↑) | 越像排越前；seq 唯一 → **全序确定，重跑结果一致** |
| 数量 | ≤ 3 | 需求既定 |

**覆盖率与质量**（2987 词全量）：无形似词 254（8.5%）→ 展示「暂缺」；1 个 231、2 个 192、满 3 个 2310。样本：`council→counsel/couch/conceal`、`stationary→stationery/sanitary/sectional`、`inevitable→invisible`、`transition→transaction/transit/transistor`、`expel→excel/expend/repel`。

**落点**：

| 文件 | 改动 |
|---|---|
| `scripts/gen_similar.py` | **新增**：算法 + 自检（无自身/无重复/≤3/候选在库内/音标非空，不过即退出不产出）→ `assets/word_lists/ielts-full-similar.json` |
| `scripts/seed_similar.py` | **新增**：HTTP API 逐词 `doc(_id).update({similar})`，4 并发；幂等（缺字段才写，`--force` 覆盖）；默认 dry-run。**已执行：2987/2987，零失败** |
| `cloudfunctions/word_card` | **零改动** —— 本来就整 doc 下发，新字段自动透传；本轮**不部署任何云函数** |
| `pages/learn/learn.wxml` | 「词根拆解」card 之后插入「形似词」card（当天按用户要求从主卡之后下移，见 §12.18 收尾）；`wx:if="{{card.similar && card.similar.length}}"` 兜底老数据 |
| `pages/learn/learn.wxss` | 新增 `.similar-item/.similar-head/.similar-word/.similar-phonetic/.similar-meaning/.sec-sub` |
| `pages/learn/learn.js` | `warmCard` 把形似词发音一起预载；新增 `playSimilar(e)` |
| `utils/mock.js` | 6 个 mock 词覆盖四态：满 3 / 2 条 / 1 条 / 空数组；w5 故意不带字段（老数据降级） |

**边界与降级**：
- 老数据 / 将来经 `seed_words` 云函数导入的新词没有 `similar` 字段 → wxml `&&` 兜底走「暂缺」，页面不炸（test_learn 有专项断言）
- 形似词发音复用 `audio.playWord`：库内 100 词有预置音频，其余走 `audio_cache` 的 dictvoice 兜底（首次下载即入云缓存，跨用户共享）；云存储增量 ≤ 2987 词 ≈ 12MB，免费额度内
- 零用户态耦合：不读不写 `today_flow`/`plan`/`user_words`，与 W2 错题复习同级，无 `markLearned` 污染风险
- 质量边界：词表本身没有的基础词对（adapt/adopt、affect/effect 不在库）不会出现——符合「库里的单词」范围

**明确不做（留档，防将来说「加一下很简单」）**：
- **点形似词跳卡**：要给 learn 页加第四种模式，而历史上最贵的 bug 正是 learn 页模式混淆（加练/复习词源写错）；只听不看够用
- **练习页干扰项优先取形似词**（`build_questions` 的 `sample(pool,3)`）：价值明确但要动判题链路，留 P2
- **全词库 Kokoro 预生成**（统一音质）：dictvoice 兜底已保证任何词能响，留 P2

**回归**：`test_learn.js` 72 全绿（新增 10 条形似词断言，含负向：缺 `data-word` 不播、无字段不炸、空数组不多发预载）；`check_miniprogram.js` 通过（新类全部有定义）；其余 page 测试全绿（index 27 / practice 42 / wrongbook 22 / audio 46 / mock 23 / app_update 11）。⚠️ `test_prototype.js` 4 条失败为**存量问题**（prototype.html 最后修改 10-12，打卡 streak 数字与断言不一致），与本轮无关。**真机验收**：开发者工具逐页比对学习页（形似词三态 + 点喇叭），本脚本链对真机零验证力。

## 12. 整理记录（考古用，日常不必读）

### 12.1 删除的死代码（均先核验零引用）

| 位置 | 内容 | 判据 |
|---|---|---|
| `miniprogram/utils/util.js` | 整个文件（`today` / `shuffle` / `sample`） | 全项目无 `require` 命中 |
| `miniprogram/app.js` | `globalData` + `ensureUser()` | 无调用方；用户态改由各页面按需 `getProfile()` |
| `miniprogram/config.js` | `Q_TYPE` 常量 | 题型标识只在云函数内部流转 |
| `cloudfunctions/today_flow` | `module.exports.dateStr` | 云函数相互隔离，导出后无人 `require` |
| `build_questions` / `submit_answer` | `attempts` 字段及其自增 | 写入后全项目从未读取 |
| `build_questions` / `utils/api.js` | `wordIds` 入参 | 词范围由云函数从当日 `plan` 自行推导 |
| `app.wxss` / `practice.wxss` | `.row` / `.btn.success` / `.option.dim` | wxml 中只有 `pf-row` / `word-row` / `q-stem-row` |
| `pages/learn/learn.js` | 重复的「预取下一张」 | `loadCard()` 内部已含预取，`onLoad` 里那次是重复调用 |

### 12.2 合并与优化

- `home_summary`：去掉 `totalCheckins` 的额外 `count()` 与无人读的 `stage` 字段 —— 每次进首页省一次 DB 往返
- `utils/audio.js`：抽出 `playSrc()`，单词与例句共用「停 → 清监听 → 设源 → 播放 → 挂 onError」，消除两处重复（原单词版还漏了 `offEnded`，与例句版不一致）
- `utils/share.js`：只导出 `toFriend`（`HOME_PATH` / `BRAND` 无外部引用）
- **品牌素材移出小程序包**：`雅词本-头像-1024.png` / `-144.png` / AI 原始图标 → `assets/brand/`。原位置在 `miniprogramRoot` 内会被打进包（约 0.8MB），且代码零引用
- **统一依赖版本**：`audio_cache` 的 `wx-server-sdk` `latest` → `~2.6.3`、`axios` `^1.6.0` → `^1.6.8`（与其余 14 个函数一致）
- **补齐 8 个缺失的 `config.json`**：`user_profile` / `home_summary` / `today_flow` / `start_new_words` / `build_questions` / `submit_answer` / `finish_checkin` / `stats`。此前超时值只能靠控制台默认，现在随代码声明

### 12.3 新增

- `cloudfunctions/init_db` —— 数据表体检 / 初始化（幂等），顺带返回手工索引清单
- `docs/deploy.md` —— 从零到可用的部署清单（含验收表、报错排查表、提审检查表）

### 12.4 有意保留（勿删，附理由）

- `audio_cache` 的 dictvoice 兜底分支与前端 `fallbackUrl`：词表外单词的能力。`audioReady` 机制保证学习流程不会触发它
- `cloudfunctions/seed_words/words.json`：被 `seed_words/index.js` 实际 `require` 的内置 24 词示例
- 各云函数独立的 `ADMIN_TOKEN` 读取块：环境变量是**函数级隔离**的，代码虽重复但无法共享
- 跨运行时的 `hashText` / `TEXT_RE*` / `slug` / `sentence_slug`：JS 与 Python 无法共享代码，**只能靠同步**。改动其中一处后务必跑 `scripts/make_audition_page.py` 预检（它会校验正则与文件头）
- 各函数内注释掉的 `nickname` / `avatarUrl`：合规说明（证明「未接入授权、不收集」）

### 12.5 第二轮：项目瘦身与词表清洗（2026-09-28）

#### 删除的过时内容

| 位置 | 内容 | 原因 |
|---|---|---|
| `specs/` | 整个目录（`design.md` + `requirements.md`） | 设计阶段历史稿；方案已全部落地为代码，PRD 的验收标准已转为 `docs/deploy.md` 的验收清单 |
| `miniprogram/project.config.json`、`miniprogram/project.private.config.json` | 两份配置 | 仓库根的 `project.config.json` 已声明 `miniprogramRoot: miniprogram/`，包内这两份不会被读取，属重复 |
| `miniprogram/images/` | 空目录 | 品牌素材已移至 `assets/brand/`，全仓零引用 |
| `cloudfunctions/{enrich_word,seed_words}/package-lock.json` | 2 份 lock | 当时 15 个函数里只有这 2 个有，反而不一致；依赖已由 `package.json` 的 `~` 约束。云函数走「云端安装依赖」，不需要 lock |
| `build/` 下 25 个文件 | 一次性校验脚本（`hash_check.*` / `check_re_sentence.*` / `fix_spacy.py` …）与临时日志 | 逻辑已固化进 `scripts/` 正式脚本，或核验已完成。产物目录，不入库 |
| `README.md` | 34KB → 约 8KB | 与 `docs/` 大量重复（部署步骤、流水线细节）。重写为概览：定位 / 目录树 / 快速开始 / 云函数清单 / 核心机制 / 注意事项 / 许可 |

#### 词表清洗（3056 → 3041 → **3036 词**）

三道清洗规则全部固定在 `scripts/build_wordlist.py` 里，**重跑即复现**，不需要手工改词表：

1. `--exclude-tags zk,gk` —— 中考/高考基础词不入表
2. `PROPER_NOUNS` —— **专名剔除**（本轮新增，见下）
3. 冗余复数去重 —— 单数已在候选池内的规则复数丢弃，共剔除 **15 个**：`apes` / `commercials` / `concessions` / `contracts` / `disputes` / `fossils` / `objectives` / `opportunities` / `photocopies` / `planners` / `precautions` / `priorities` / `tablets` / `tunnels` / `workshops`。⚠️ 其原始实现（「以 `s` 结尾 + 规则还原的单数在候选池内」）只是**字符串猜测**，既漏 `tours` 又误判 `ambitious` / `crisis` / `series` / `campus`，已在**第三轮**被 §11.6 的「名词复数归一」整体取代

例外表 `KEEP_PLURAL` 保留**形似复数、实为独立词条**的词（完整清单以脚本为准）：`-ics` 学科名词、语义分化词（`odds` / `pants` / `savings` / `contents` …）、集合用法 `bacteria`、单复数同形 `news` / `series` / `species`。

另外两项：文件名 `ielts-5000.json` 名不副实（实际只有 3056 词），已改名 **`ielts-full.json`**——**刻意不带词数**；`--limit` 默认由 `5000` 改为 `0`（不限）。

##### 专名剔除（本轮新增）

**问题**：ECDICT 的 `ielts` 标签里混入专名（这些词在相关语料里出现过，就被打上标签）。它们朗读没问题，但作为「词汇」毫无学习价值，还挤占学习队列——`york` 因 `New York` 语料频次极高，被按 BNC 排到了**第 48 位**，等于让用户很早就学一个人名/地名。

**判据**（取自 ECDICT 自身的两个字段，在合格候选池上命中 5 个、**0 误报**）：

| 规则 | 判据 | 命中 |
|---|---|---|
| A | 中文释义的括号注释是「地名/姓氏/王朝」类标记 | `sydney`（澳大利亚港市）、`forbes`（美国出版及媒体集团）、`tours`（姓氏）、`wollongong`（澳大利亚东南部港市） |
| B | 英文释义是地名 / 王室的**指认句式** | `york`（the English royal house … reigned from）、`sydney`（the largest Australian city located in …） |

两条都刻意收紧过：早期宽松写法（任何含 `city` / `town` / `state` 的释义）命中 **106** 个，绝大多数是 `the state of being …` 这类正常释义，**不可用**。

**逃生舱**：`KEEP_PROPER_LOOKING` —— 万一将来 ECDICT 更新后某个正经词被规则命中，加进去即可放行，无需改判据；`PROPER_NOUNS` 里的显式清单同时作为判据的兜底，词表重建时会打印全部被剔除的专名，并对「列在清单里但已不再命中判据」的条目报警，便于复核。

**注意**：`guy`（seq 270）**不是专名**，已保留——柯林斯 4 星、牛津 3000 核心词、有完整词形变化（`guys` / `guyed` / `guying`），释义「家伙」是正经的常用义。

**连带影响**：`york` 原本在 48 位，剔除后 pilot-100 由「`york`」换成「`discipline`」（原第 101 位），其余 99 词不变；`assets/examples/pilot-100-examples.json` 与 `build/` 下的音频、入参批次已同步重建。（`discipline` 在第三轮又因排序重排移出 pilot-100，见 §12.6。）

> ⚠️ **破坏性语义**：若云端已导入过任何旧词表（3056 / 3041 / 3036 词），必须用 `reset_words`（`purge`）清空后重导，**不能**直接 `seed_words` —— 它按 `word` 去重跳过，`wheels` / `jobs` 这类已删词会留在库里。

#### 新增

- `scripts/pack_words.py` —— 把词表打包成 `seed_words` 入参：按 `--batch-size`（默认 200 词）切分，每批是一份**完整可用**的入参（约 38KB，控制台入参框吃得下），并产出 `index.json` 清单（含每批词数与首末词）。此前导词表只能手搓 JSON，或用 `offset/limit` 反复粘贴整份词表
- `docs/deploy.md` 新增 **§0.1 老环境升级增量清单**（哪些云函数要重部署、词表为什么要先 purge）

### 12.6 第三轮：名词复数归一（2026-09-28）

**问题**：ECDICT 的词形标记不完整——`ielts` 标签打在**复数**上、原形反而被当基础词排除。结果是词表尾部堆了一整簇「只有复数、没有单数」的条目（`wheels` / `utensils` / `universities` / `volunteers` …），学习价值为零：该先学 `wheel` / `utensil`，而不是把复数形式当成独立词汇去背。

**判据**（改取 ECDICT 自身的 `exchange` 字段，不再做字符串猜测）：

| 条件 | 含义 |
|---|---|
| `exchange` 的 `0:` 指向**别的**词 | 本条目是变形词。`0:` 指向自身的 `outskirts` / `tweezers` / `stairs` / `surroundings` 是英语里天然只有复数形的名词，必须放行 |
| 变形标记只有 `s` / `3` | 排除同样带 `0:` 但属独立词条的 `best`(`0:good`,t) / `further`(`0:far`,r) / `advanced`(dp) / `banking`(i) / `sophisticated`(dp) / `regarding`(i) / `provided`(dp) |

两条同时满足即为「纯复数」，再按原形分三种处置：

| 情形 | 处置 | 结果 |
|---|---|---|
| 原形已在表内 | 丢弃（冗余复数） | 15 个（`apes` / `contracts` / `opportunities` …） |
| 原形是基础词（zk/gk） | 丢弃——不因复数把基础词拖回表 | 49 个（`wheels`→`wheel`、`jobs`→`job`、`universities`→`university` …） |
| 原形查得到且非基础词 | **提升为原形**：音标/词性/释义取原形，`seq` 位不变，`source` 记为 `ecdict-ielts-lemma` | 14 个（`utensils`→`utensil`、`elements`→`element`、`threats`→`threat` …） |

⚠️ 两个**看起来更简单、实际是错的**方案，已写进脚本注释避免重蹈：
- 「一律剔除所有变形词」→ 连 `banking` / `housing` / `further` / `best` / `sophisticated` / `regarding` / `provided` 在内会杀掉 **161** 个合法词条（`guy` 之外的另一个大坑）
- 「一律用原形替换」→ 把 `wheel` / `job` / `light` / `floor` / `tour` / `university` 这些中考/高考基础词重新拖回表，与筛选漏斗的目的直接冲突

**排序**：提升的原形按**自身**词频落位（不沿用复数的词位），列表因此严格保持 BNC 序——`element` / `threat` / `inquiry` 这类常用词会回到它们该在的位置，而不是烂在词表尾部。代价是 seq 整体重排，前 100 词会换掉 2 个。

**连带影响**：`pilot-100` 由 `discipline` / `housing` 换成 `element` / `threat`，其余 **98 词不变**；`assets/examples/` 与 `build/` 下的单词·例句音频、入参批次已重跑同步（音频以单词为 key、例句以整句文本为 key，seq 重排不会使已有文件失效）。

词表 **3036 → 2987 词**；`seed_words` 入参由 16 批变为 **15 批**（`pack_words.py` 重跑生成）。

### 12.7 第四轮：数据库初始化本地化（2026-09-29）

**动机**：原先初始化数据表只能在控制台手点——7 个集合 + 10 条索引共 17 次点击，漏一个就要等运行时才炸。

**关键发现**：微信云开发的 HTTP API 除了建集合，还提供 **`/tcb/updateindex`**——这是**控制台之外唯一的建索引途径**。配合 `/tcb/databasecollectionget`（返回里带 `index_count`）就能做幂等体检。

| 能力 | 接口 | 本地可做？ |
|---|---|---|
| 取凭证 | `GET /cgi-bin/token` | ✅ |
| 查集合（含 `index_count`、`count`） | `POST /tcb/databasecollectionget` | ✅ |
| 建集合 | `POST /tcb/databasecollectionadd` | ✅ |
| **建索引** | `POST /tcb/updateindex` | ✅ |
| **安全规则（权限）** | —— | ❌ 无接口，仍须控制台 |

**新增 `scripts/init_cloud.py`**：默认体检（只读），`--apply` 执行。要点：

- 配置自动发现：AppID 读 `project.config.json`，环境 ID 读 `miniprogram/config.js`；只有 AppSecret 需写进 `.env` 的 `WX_APP_SECRET`
- access_token 缓存到 `build/.wx-token.json`（微信有频率限制，反复取会互相顶掉），`--refresh-token` 强制换新
- 建索引**幂等**：已存在的报 exists 视为通过；复查用 `index_count − 1` 估算自定义索引数（`−1` 是减去内置 `_id_`）
- **清单漂移告警**：比对 `assets/db-indexes.json` 与 `cloudfunctions/init_db/index.js` 的索引条数，有一边改漏就提示

**新增 `assets/db-indexes.json`** —— 集合与索引的**权威清单**（含每个索引的字段与升降序、唯一性）。`init_db/index.js` 里那份是控制台路径的等价副本。

**另外发现**：开发者工具自带 CLI（`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`）支持 `cloud functions deploy`，可**一条命令批量部署全部云函数**（`--remote-npm-install` 等价于「云端安装依赖」），省掉逐个数手点。不提供「调用云函数」，故初始化仍走 `init_cloud.py`。

⚠️ 补充实测（2026-09-29）：用 CLI 前**必须先在 IDE「设置 → 安全设置」打开「服务端口」**，否则命令**静默卡死**（跑满 3 分钟无任何输出后被系统杀掉，不报错、不提示）。另：**云函数管理没有 HTTP API**——`/tcb/getfunctionlist` 返回 `40066 invalid url`，所以云函数的列表与部署只能走 IDE 界面或该 CLI，是本项目唯一无法「本地一键」的环节。

⚠️ ~~**HTTP API 触发云函数的超时只有 5s**（官方文档明确）→ 所以 `seed_words` / `seed_audio` 这类大入参的不能改走 HTTP API，仍须用控制台「云端测试」逐批执行。~~
→ **这条结论在第五轮被推翻了**：数据根本不必绕道云函数，直接用 `/tcb/databaseadd` 写库即可，见 11.8。

**安全**：AppSecret 是最高权限凭证，只放本地 `.env`——**不要写进小程序代码，也不要配到云函数环境变量**。

### 12.8 第五轮：数据导入也本地化，初始化全流程一条命令（2026-09-29）

**动机**：11.7 之后「建表」能本地做了，但**数据**还卡在控制台——`seed_words` 15 批 +
`seed_audio` 2 批 + `seed_sentence` 5 批，共 22 次「云端测试」粘贴。

**关键发现**：云开发 HTTP API 的**数据库写接口全都能用**，于是完全不必绕道云函数：

| 能力 | 接口 | 实测 |
|---|---|---|
| 读数据 | `POST /tcb/databasequery` | ✅ 支持 `db.command.*`、`limit` 1000、`skip` 翻页 |
| 批量写 | `POST /tcb/databaseadd` | ✅ `add({data:[...]})` **数组一次多条** |
| 批量改 | `POST /tcb/databaseupdate` | ✅ `where({...}).update({data:{...}})` |
| 批量删 | `POST /tcb/databasedelete` | ✅ `where({...}).remove()` |
| 传文件 | `POST /tcb/uploadfile` + COS 直传 | ✅ 见下 |
| 删文件 | `POST /tcb/batchdeletefile` | ✅ 文件不存在返回 `STORAGE_FILE_NONEXIST`，不算错 |

**云存储上传的坑**（试错三次才通）：

- `uploadfile` 返回 `url` / `authorization` / `token` / `file_id`，第二步要 **POST multipart** 打到 `url`
- **签名必须放 `Authorization` 请求头**，**且表单里要带 `key` 字段**：
  用 `PUT` → `403 SignatureDoesNotMatch`（微信给的是 POST Object 的签名）；少 `key` → `400 MalformedPOSTRequest`

**索引口径的坑**：11.7 那套「`index_count − 1` 估算自定义索引」偏大 1。
实测发现云开发会**给每个集合自动建 `_openid_1` 索引**（默认权限「仅创建者可读写」要靠它），
正确口径是 `_id_` + （清单是否已含 `_openid_1` ? 0 : 1）+ 清单条数。
另外 **`updateindex` 是幂等的**：同名索引重复创建不会重复添加（`index_count` 稳定不变）。

**新增 `scripts/wxcloud.py`**：HTTP 客户端抽成公共层（token 缓存、`Cloud` 句柄、
`query / add / update / remove / purge / upload / remove_files`），`init_cloud.py` 与 `seed_cloud.py` 共用。

**新增 `scripts/seed_cloud.py`**：一条命令做完五件事，全部幂等——词表（按 `word` 去重）→
例句富化（只补未富化的）→ 单词音频 → 例句音频（按 `(text, type)` 去重）→ 点亮 `audioReady`。

- `--reset`：清 `words` / `user_words` / `records` / `daily_plans` + 归零 `users.wordCursor`
  （保留 `checkins` / `audio_cache` / `users`），清空前**自动备份**到 `build/backup/`
- 依赖 `build/audio/manifest.json` 与 `build/sentence_audio/manifest.json`（含 `word` ↔ `text` ↔ 文件 的映射）

**实测结果（清空重导）**：424 条旧词（字母序）+ 65 条派生数据清空并备份 → 导入 **2987 词**（seq 1..2987）→
上传 **200 个音频**（100 单词 + 100 例句，0 失败）→ `audio_cache` 200 条 → `audioReady` 100 词。
**第二遍重跑：新增 0 / 跳过 200 / 新点亮 0，数据零变化**（幂等成立）。

**连带修正**：`docs/deploy.md` 第 6/7/8/9/10 节改为「本地一键（推荐）+ 控制台（等价备选）」；
`ADMIN_TOKEN` 从「必配 5 个函数」降级为「只在走控制台路径时才需要」。

### 12.9 第六轮：每日一句补音频（2026-09-29）

**问题**：首页「每日一句」的喇叭点了没声音，也不报错。

**根因**：M12 把每日一句做成纯前端静态语料（`utils/quotes.js`，12 句按日取模轮换），
但它的喇叭走的是**例句音频链路**——而例句音频必须先由 `seed_audio` 预置进 `audio_cache`。
这 12 句**从未进入任何音频生成流程**（`gen_examples.py` 只处理 100 个单词的例句），
于是 `audio_cache` 查不到 → 返回 `NOT_PRESEEDED` → `playSentence` 的 `if (!src) return`
**静默跳过**。表现为「没声音也没提示」。

**佐证（三条独立证据）**：
- `build/sentence_audio/manifest.json` 实测 100 条，与 12 句逐条比对 **0 命中**（近似匹配也 0）
- 直连 `dict.youdao.com/dictvoice` 请求整句 → **HTTP 500 / 120 字节 JSON**（type 1、2 都一样），
  印证「整句无第三方兜底」的判断
- 云端 `audio_cache` 原始 200 条 = 100 单词 + 100 例句

**修复**：新增第三条本地流水线（见 7.8），生成并上传 12 句音频。
实测：Kokoro 合成 **12 句 / 216.3 KB / 平均 18 KB**（耗时 7s）→ 上传 12 个、0 失败（13.3s）
→ `audio_cache` **200 → 212 条** → 按 `(text, type)` 复查 **12/12 命中**。
真调 `audio_cache` 云函数（今日那句）返回 `{code:0, data:{fileID:"cloud://…/audio/2/s_d9vqeq.mp3"}}`。

**新增文件**：
- `scripts/quotes_to_examples.py` —— 从 `quotes.js` 现抽现转 `assets/examples/quotes-12.json`
  （`quotes.js` 恒为唯一数据源，并断言条数与声明数一致）
- `scripts/seed_quote_audio.py` —— 上传 + 写 `audio_cache`，含三道自检、`--apply` 门禁、`--force` 覆盖

**⚠️ 顺手挖出的一个坑（此前排查云函数时一直被误判）：**
云开发 HTTP API `POST /tcb/invokecloudfunction?access_token=X&name=fn` 的入参格式是
**「事件字段平铺在 body 顶层」**，不是文档常写的 `{"env":…, "data":{…}}`：
套在 `data` 里（无论传对象还是 JSON 字符串）函数都收不到字段（`audio_cache` 一律回
`{"code":-1,"message":"missing text"}`），平铺才能拿到参数。
之前用 `{env,data}` 探测 `stats`/`today_flow` 恰好能「正常返回」，是因为那两个函数**不需要入参**，
于是把错误格式误判成了可用格式——**用无需入参的函数试格式，会得到假阳性**。

**同类坑：取云存储临时链接的字段名也不是直觉写法。**
`POST /tcb/batchdownloadfile` 的 body 要写成
`{"env":"…","file_list":[{"fileid":"cloud://…","max_age":600}]}` ——
参数名是 **`file_list`（数组、每项含 `fileid` + `max_age`）**。
写成 `{"env":…,"fileids":[…]}` / `{"fileid":…}` 一律回 `47001 data format error`（不是「文件不存在」，
所以别被这个错误码带去查文件）。用它验证过一次：12 句里的今日句实下 **19728 B、首字节 `ff f3`**（合法 MP3 帧同步）。

### 12.10 第七轮：错题本「已掌握」（2026-09-29）

**需求**：用户提出「错题本加一个删除按钮或已掌握」。

**选型：做「已掌握」，不做「删除」** —— 错题本是学习清单，不是文件管理器：

- 语义更准：「这个词我会了」而不是「这条记录我不要了」
- **可复活**：之后再答错自动回到错题本。靠「新记录天然不带 `mastered` 字段」实现，零额外代码
- **不删流水**：只在 `records` 上打标，`stats` 查询层过滤。若物理删记录，
  将来按 `records` 统计正确率会被「洗高」——流水必须保持完整

**后端**：新增云函数 `dismiss_wrong`（**共 18 个**），`stats` 的错题查询改为
`{_openid, isCorrect:false, mastered: _.neq(true)}`。
⚠️ MongoDB 的 `$ne` 会一并匹配「字段不存在」的文档 → **老数据不需要回填**。

**前端** `pages/wrongbook/`：卡片右侧加「已掌握」胶囊按钮。三个必须踩准的点：

1. **必须 `catchtap`**：卡片本体是 `bindtap` 播放发音（M10-1），不拦冒泡就变成
   「点了只响一声、什么也没发生」。它完整坐落在卡片热区**之内**（嵌套，不是并列压盖），
   已确认不会误触播放——这是 M10-1「父子热区」规则的**唯一例外**，理由写在 wxml 注释里
2. **热区 88rpx**（与 `.speaker` 同口径 ≥44px），但视觉是小胶囊：外层管热区、内层管视觉，
   避免 88rpx 高的大药丸抢走卡片视觉重心
3. **不用 `wx.showToast`**：错题本是 tab 页、底部有原生 tabBar，toast 会被压住（M19-1 TOAST_COVER）
   → 改为页内**顶部提示条**（4 秒自动收起），并给 `api.dismissWrong` 传 `silent:true` 把错误交给页面处理

**交互**：`wx.showModal` 二次确认 → **乐观移除**（不等云函数往返）→ 失败回滚 + 顶部提示条；
`_busy` 连点锁覆盖「确认框还开着」这段窗口，防止连弹 / 误伤别的词。

**顺手修的**：`wrongbook.js` 原来只有 `onUnload` 停播，但 tab 页切走只触发 `onHide`
（`index.js` 早已按这条规范处理过）→ 补上 `onHide`，否则切走之后喇叭还在响。

**新增回归测试 `scripts/test_wrongbook.js`**（14 条，零依赖，node 直跑）：
`check_miniprogram.js` 只审结构，一条页面 JS 行为都查不到；而「乐观更新 + 失败回滚 + 连点锁」
恰好是最容易改回归、且真机上最难手动复现（造不出「云端失败」）的部分。
做法：桩掉 `wx`/`api`/`audio`/`share`，用 `require.cache` 注入后**直跑真实页面 JS**。
其中「乐观更新」这条用一个**挂起不返回**的 `dismissWrong` 桩来验：云端未回包时列表就该已经变了。

> **有效性已负向验证**（避免「假绿」）：把 `catchtap` 改回 `bindtap` / 删掉 `onHide` /
> 删掉失败回滚，三处故意改坏都被对应断言抓到，各自 FAIL 且退出码非 0。


**仍待办**：`build/quote_audio/` 与 `build/sentence_audio/` 都是本地产物，未纳入版本控制（`build/` 已 gitignore）；
换机器或换云环境后需重跑 ①②③。


### 12.11 第八轮：错题本点词进复习（2026-09-29）

**需求**：用户提出「错题本点单词也可以跳到学习单词的页面复习，可以返回错题本」。

**纯前端，零云函数改动** —— 复用学习页现有的 `word_card` 链路，不需要重新部署任何云函数。

**入口（`pages/wrongbook/`）**：
- 整卡 `bindtap` 从 `play` 改为 `openReview` → `wx.navigateTo('/pages/learn/learn?review=<_id>')`
  （learn 是非 tab 页，navigateTo 保留页面栈；返回时本页 `onShow` 会重拉 `stats`，所以
  复习期间的变化回来就是最新的）
- 喇叭随之改为独立的 `catchtap="play"`：**这一条修订了 M10-1**（原规则「整卡可点=发音、
  喇叭不单独绑 tap」）。整卡行为换成跳转后，发音必须有自己的热区，于是本页的热区关系变成
  「一个父热区 + 两个 `catchtap` 子热区（喇叭 / 已掌握）」，都嵌套在卡片内、都有 88rpx 热区，
  用 `catchtap` 隔断冒泡 → 不误触
- `_jumping` 连点锁（navigateTo 有延迟，连点会叠出两层学习页，返回一次还停在学习页）；
  锁在 `onShow` 里解除 —— 回到本页即可再点，跳转失败（如页面栈满 10 层）也不会永久锁死

**学习页新增第三种模式（`pages/learn/`，`review=<wordId>`）**：
- 词源**只来自参数**：不读 `today_flow`、不调 `start_new_words`、不调 `start_extra_round`
  —— 后两者会推进当日游标 / 写 `learnedIds`，否则**点一下错题本就把今日进度改了**（同加练的 C2 坑）
- 单卡：头部「错题复习」、`1 / 1`、底栏按钮「复习完成」
- `next()` 只做两件事：停播 + 退回错题本（`navigateBack`；无上一页时兜底 `switchTab` 到错题本
  —— tab 页只能 `switchTab`）。**不调 `markLearned`**：复习 ≠ 已掌握，要不要标记由错题本上的按钮决定
- 进词仍自动播单词发音（与主流程一致）
- 底栏按钮文案从 wxml 的三重三元收敛成 `data.nextLabel`（四态在 `loadCard` 一处算）

**回归测试**：
- 新增 `scripts/test_learn.js`（29 条）：三种模式（`review` / `round=0` / `round>0`）各自的
  词源、`markLearned` 参数、按钮文案、跳转目标，重点盯「**不该调什么**」——这类约束
  `check_miniprogram.js` 一条都查不到
- `scripts/test_wrongbook.js` 14 → 21 条：新增「点卡片带上词 id」「连点只跳一次」「返回后可再点」
- **有效性已负向验证**：删掉 review 分支的 `return`（会去读 today_flow）、删掉 next 的 review 分支、
  把返回改成跳练习页、删掉错题本连点锁、把喇叭改回 `bindtap` —— 5 处故意改坏各自触发对应断言 FAIL

### 12.12 第九轮：加练计入「累计学习」（2026-09-29）

**需求**：用户提出「再来一组也加入到累计学习」。

**这是 D3 决策的反转** —— 加练上线时用户选了「不计入」（`totalLearned` 只统计主流程），现改为**计入**。
口径严格对齐 `finish_checkin`：**结算时按整组一次性入账**，不是「学一个加一个」。

**改动（仅 1 个云函数 + mock 层）**：
- `finish_extra_round`：`users.totalLearned += wordIds.length`（与 `finish_checkin` 用
  `plan.newWordIds.length` 对称），返回值 `totalLearned` 改为**入账后的新值**
- ⚠️ **幂等分支绝不重复累加**：组 `stage==='done'` 时只回读当前值。这是本函数唯一的计数风险点 ——
  前端重试/连点都会走到这条分支，一旦写错就是「加练一次、累计涨两倍」
- `home_summary` 注释订正：`extraLearnedToday`（当日走过学习页的加练词数）与 `totalLearned`
  （已结算入账）**口径不同**，前者含「学了还没做完小测」的在途组，所以 ≥ 入账量是正常的
- mock 层 `totalLearned` 从各处硬编码 168 改为**模块级可变 `mockUser`**：`homeSummary`/`stats` 读它，
  `finishExtraRound`/`finishCheckin` 累加。若不改，USE_MOCK 下「加练后累计 +N」看不到，
  前端接线错了也发现不了（mock 与真机行为分叉）

**「中途退出不入账」是刻意的**：与主流程一致 —— 学了一半不做小测就不结算；这些词因 `wordCursor`
未推进，次日会被 `start_new_words` 当新词重新取到，届时由 `finish_checkin` 计入。**不会漏计，只是延后。**

**测试**：
- 新增 `scripts/test_finish_extra_round.js`（21 条）—— **本项目第一个云函数逻辑无头测试**。
  桩掉 `wx-server-sdk`（本地没装，云端才装）+ 内存假 DB，直跑真实的 `index.js`：
  首次结算 / 重复结算 / 三连结算 / 未全对拒绝 / 组不存在 / 空词组 / 三组累加，
  并守住 `streak`、`checkins`、`plan.stage` **不被加练污染**
  - ⚠️ 桩的坑：云函数**顶层**就执行了 `db.collection(...)`，所以假 DB 必须「每次查询时重读 store」，
    否则换用例时 collection 句柄还攥着旧数组
- `scripts/test_mock.js` 加练体检段：从「结算后 totalLearned **不变**」改为相对量断言
  「增量 === 本组词数 + 重复结算不重复计 + 首页读数同步」
- **两个脚本都做了负向验证**：mock 层 3 处（不累加 / 去掉幂等判断 / 首页写死）、
  云函数 3 处（不写 `totalLearned` / 幂等分支失效 / 顺手改 `streak`）—— 全部被抓到

### 12.13 第十轮：加练按钮「中途退出被锁死」（2026-09-29）

**用户报障**：「再学一组，可以重复执行 —— 刚才可以再学一组，现在又不行了。」

**诊断（直接查云端真实数据，不猜）**：`daily_plans` 当日那条
`extraRounds = 3 组`（round 1/2 `done`，**round 3 停在 `learnedIds=1/5`**），
`users.wordCursor=15`，游标之后 `audioReady` 词还剩 85 个。于是：

- 云端 `today_flow` 算出的 `canStart = 已打卡 && (有未完成组 || 未达上限未取尽)` → **`true`**（第 3 组没做完）
- 但前端 `buildExtra()` 里是 `if (ex.limitReached) return hide` —— **先判上限，直接隐藏**

**根因：前端把「已建满 3 组」的中途退出者锁死了。** 建满第 3 组的那一刻起，首页按钮消失，
用户再也回不到自己那组（round 3 永远停在 1/5）。而云端一直认为可以继续 → 前后端口径不一致。

**修复（`miniprogram/pages/index/index.js` 的 `buildExtra`，纯前端）**：把判断顺序改成

| 序 | 条件 | 表现 |
|---|---|---|
| 1 | 未打卡 | 隐藏 |
| 2 | 无 `extra` 字段（旧版云端） | 乐观显示（原有约定，保留） |
| 3 | **`pendingRound` 非空** | **显示 + 可点，文案「继续学一组」** ← 本次修复 |
| 4 | `exhausted` | 显示 + 置灰 + 底栏「预置发音的词已学完…」 |
| 5 | `limitReached` | 显示 + 置灰 + 底栏「今日加练已达上限，明天可继续」 |
| 6 | 正常 | 显示 + 可点「再学一组」 |

⚠️ 第 4/5 条**从「整个隐藏」改成「置灰 + 说明原因」**，是对 M13 原设计的**有意偏离**：
按钮凭空消失正是本次报障的观感，把原因写在底栏比静默消失好排查。不想要可改回。

**不需要部署云函数**：云端 `canStart` / `pendingRound` 本来就正确，`start_extra_round`
也会幂等复用未完成的组 → 这次只是前端没读对。

**新增 `scripts/test_index.js`（16 条）**：直跑真实 `pages/index/index.js` 的 `buildExtra`，
覆盖上表 6 种状态 + 2 条源码面断言（那个坑不能回来、`pendingRound` 必须排在 `limitReached` 前）。
**负向验证 3 处**：复现原 bug（插回 `if (limitReached) return hide`）/ 未打卡也显示 / 取尽不给原因 ——
全部被抓到，文件已复原。
⚠️ 写断言时踩到**假失败**：源码面断言的正则匹配到了**我自己写在注释里的反例**，
必须先剥掉注释行再匹配（字符匹配类断言的老问题，本项目已踩过多次）。

**同日追加（用户拍板两项）**：

1. **每日上限取消 → 不限次数**。`today_flow` 与 `start_extra_round` 的 `MAX_ROUNDS_PER_DAY`
   都置为 `Infinity`（常量与判断代码**保留原位**，将来要恢复上限只改常量）。
   `limitReached` 字段保留、恒为 `false` —— 前端契约不变，不必一起改。
   唯一的自然终点变成 `exhausted`（`audioReady` 词池取尽）。
   ⚠️ mock 层的 `MAX_EXTRA_ROUNDS` 同步置 `Infinity`，否则 `USE_MOCK` 下与真机行为分叉。
2. **恢复未完成组时跳过已学过的词**（`pages/learn/learn.js` 的 `round>0` 分支）：
   按该组 `learnedIds` 过滤 `wordIds`，直接从下一个没学的词继续；进度条与「N / M」
   也随之只反映**剩余**词数。`learnedIds` 由 `today_flow(markLearned, round)` 用
   `addToSet` 累积，天然幂等，不会重复计数。
   - 边界：**词都看完了但小测没做**（组仍 `pending`）→ 剩余为空，直接
     `redirectTo /pages/practice/practice?phase=practice&round=N` 进小测，
     不让用户对着空列表（`build_questions` 会按该组 `wordIds` 重建队列，无需额外处理）。

**仍待办**：`finish_extra_round` 的新版（加练计入累计学习）尚未部署 —— 本次云端数据显示
第 2 组已结算但 `totalLearned` 未增，正是「漏传」的表现。

### 12.14 第十一轮：复习链路审查修复（2026-10-13）

**起因**：用户问「复习昨日新学的单词」逻辑是否正确 → 对
`finish_checkin → today_flow → build_questions → submit_answer` 全链路做了一轮审查
（另核对错题本 `stats` / `dismiss_wrong` 两条支线）。

**主链路确认正确**（无需改动，留档防回退）：昨日新词次日准时进复习集合（`nextReviewDate=次日`）、
mastered 双保险不再出现、复习答对就地结算、状态机不断链（review→learning 后
`startNewWords` 自动补词）、昨日未打卡不丢词（`wordCursor` 不推进→重学同批）、
加练词同链路进复习、答错重选对的 clean 判定。

**修复 5 项（用户拍板「全修」）**：

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| R1 | 错题本点了「已掌握」，次日复习照考 | `dismiss_wrong` 只打 `records` 标，而复习集合查 `user_words`，两套系统不通 | 打标同时把 `user_words` 该词置 `mastered` + `nextReviewDate=''`；记录不存在**不建**（学了没打卡→次日重学自愈）。只影响「明天起」——当日 reviewQueue 是建 plan 时的快照 |
| R2 | 昨日练习答错的词，次日一轮答对即「掌握」 | `submit_answer` practice 阶段有 `if (uw)` 守卫，新词首次做题时 `user_words` 还没有记录；`finish_checkin` 又统一按 `wrongCount:0` 注册 → clean 判定看不见昨天练习答的错 | 新词首次答错（非 review 阶段）落一条**只带 `wrongCount:1`** 的记录，不写 `status`/`nextReviewDate`（`$lte` 不匹配字段缺失，没打卡不会提前进复习集合）；`finish_checkin` 幂等分支补调度字段且**不覆盖 wrongCount**（已在代码注释钉住该隐式契约） |
| R3 | 复习中途退出重进，已答对甚至已 mastered 的题重出 | `build_questions` 复用整条 queue（含 `passed:true`），前端不过滤 | `practice.js` 新增 `applyQuestion()`：载入/翻到已 `passed` 的题直接呈已答对态并 900ms 自动过。**只在呈现层跳过**——`questionIndex` 是 `submit_answer` 落库下标，队列顺序动不得 |
| R4 | 到期词超 50 条时队尾饿死 | `today_flow` 到期查询 `limit(50)` 无排序，按数据库自然序截断，天天取同一批 | 加 `.orderBy('nextReviewDate','asc')`，最老先复习 |
| R5 | 文案「先复习昨天的单词」不准 | 断档 N 天复习的是 N 天前的词；昨天无新词时是历史到期词 | 首页 CTA 改「先复习到期的单词」，练习页 tag 改「复习到期单词」（纯前端）。**⚠️ 2026-10-14 用户拍板改回「昨天/昨日」措辞，见 §12.17 —— 本条已被推翻，仅留档** |

**R6 未纳入（设计语义，非缺陷）**：复习集合实际 = 昨日新词 + 昨日复习答错的历史词（滚动）。
这是 §7.4 的核心设计；若要严格限定「仅昨日新词」，答错的词将失去次日复习位，需用户另行拍板。
→ **已于 §12.15 落地：用户拍板「仅昨日新词、错词次日不再自动复习」，§7.4 已重写。**

**测试**：新增 `scripts/test_submit_answer.js`（36 条，含「昨日答错→打卡→次日复习」跨函数联动）、
`scripts/test_dismiss_wrong.js`（17 条）、`scripts/test_today_flow.js`（22 条，R4 排序 + C2 路由）；
`test_practice.js` 37→42 条（R3）。`_fn_harness.js` 补两处：`orderBy` 字符串字段按字典序
（日期串相减得 NaN 会静默吞掉排序断言）、`applyUpdate` 认 `_.addToSet`/`_.inc` 命令对象
（早期直接把命令对象赋进字段，读起来像「写成功了」）。
**负向验证 4 处**（R1–R4 逐一改坏看红，均已复原）。全量回归 11 个测试文件 326 条全绿。

**需部署**：`today_flow` / `dismiss_wrong` / `submit_answer`（`finish_checkin` 仅注释、无需部署；
R3/R5 纯前端）。

### 12.15 第十二轮：R6 复习出池 + 发版自动更新（2026-10-13）

**起因**：§12.14 审查后，用户对 R6 拍板「**仅昨日新词、错词次日不再自动复习**」，
并要求「小程序发完版，自动更新」。

**R6：复习集合严格限定为昨日新词（改设计，§7.4 已重写）**

| 改动 | 文件 | 说明 |
|---|---|---|
| 新增 `user_words.status` 第三态 **`reviewed`**（出池终态） | `submit_answer` | review 阶段答对 clean → `mastered`；否则（本轮答错 / 历史有错 / 答错）→ `reviewed` + `nextReviewDate=''`。**任何阶段答错都不再写「次日报到」** |
| 到期查询改**正相匹配** | `today_flow` | `status: 'reviewing'` 取代 `_.neq('mastered')` —— 出池终态也是「非 mastered」，用 neq 会把答错的词捞回池，「错词次日不再自动复习」被悄悄破坏且不报错 |
| 入池路径收敛为一条 | — | 进 `reviewing` 只有 `finish_checkin` / `finish_extra_round` 注册（`nextReviewDate=次日`）→ **池内 = 昨日新词（含加练词）** |
| 出池词的出路 | `dismiss_wrong` | 答错流水在 `records` → 错题本照收；**「已掌握」是 `reviewed` 转正 `mastered` 的唯一入口**（R1 的同步逻辑不变，只是从此多承担这一职责） |

三个有意保留的判断：
- `nextReviewDate ≤ today`（而非 `== today`）不变：断档 N 天回来时，之前注册没来得及
  复习的词要能补上；配合升序，最老先复习（R4 仍然有效）。
- 复习是**一轮一次性测验**：当天答错仍要重选到对才能过题（前端禁选 + `passed`
  由答对时置位），出池只影响「明天还考不考」，不影响当天流程。
- R2 的半条记录（只带 `wrongCount`）后果从「留次日报到」变为「出池而非毕业」：
  昨天练习答错的词，次日复习答对也非 clean → `reviewed`，要等错题本点「已掌握」。

**发版后自动更新（`miniprogram/app.js`）**
- `onLaunch` 接 `wx.getUpdateManager()`：`onCheckForUpdate`（打日志）/
  `onUpdateReady`（`showModal` 不可取消 → 确认后 `applyUpdate()`）/
  `onUpdateFailed`（静默，下次冷启动微信自己重试）。
- 三个取舍（代码注释已钉）：① 只在 `onLaunch` 绑一次——`getUpdateManager()` 返回
  **全局唯一**实例，onShow 重复绑会叠加监听连弹多次；② 用弹窗而不是直接
  `applyUpdate()`——直接重启会硬切串行落库链（syncAnswer 在途的那条
  `submit_answer` 会丢），弹窗让用户自己挑时机；③ 低版本基础库无该 API 时静默返回
  （走微信默认行为：下次冷启动生效）。
- 新增 `scripts/test_app_update.js`（11 条：三回调绑定 / 弹窗契约 / applyUpdate /
  失败静默 / 低版本兜底）。

**测试**：`test_submit_answer` 36→**37**、`test_today_flow` 22→**23**（补 R6 出池排除）、
`test_dismiss_wrong` 17→**20**（补 `reviewed` 转正用例）、`test_practice` 42 不变、
新增 `test_app_update` **11**。**负向验证 5 处**（R6 三处 + 更新两处：改坏后 4 处断言红、
1 处进程崩溃退出码 1，均非静默）。全量回归 **12 个文件 342 条全绿**，
`check_miniprogram.js` 通过。

**需部署**：`today_flow` / `dismiss_wrong` / `submit_answer`（R6 改了这三个；
`finish_checkin` 自 §12.14 起仍未再动、无需部署）。自动更新在小程序**发布新版本**后
由微信客户端触发，不需要额外部署动作（上传代码即生效）。

### 12.16 第十三轮：学习页「上一个」按钮（2026-10-14）

**起因**：用户要求「每日学习单词要加一个上一个的按钮，可以返回上一个单词学习。注意单词数量边界」。

**实现**（纯前端，`pages/learn/*`，不部署）：

| 文件 | 改动 |
|---|---|
| `learn.js` | 新增 `prev()`：`locked` 锁 + `index<=0` 边界兜底 + `loadCard(index-1)` |
| `learn.wxml` | 底栏改按钮行：`wx:if="{{index > 0}}"` 的 ghost「上一个」+ 原主按钮（复用 `app.wxss` 现成 `.btn.ghost`） |
| `learn.wxss` | 新增 `.btn-row`（flex + gap），主按钮 `flex:1` 保持满宽 |

**边界处理（用户特意叮嘱，三层）**：
1. **第 1 个词**：WXML `wx:if` 不渲染按钮 + JS `index<=0` 兜底（双保险，防将来有人把 wx:if 改成常显）；
2. **错题复习（W2）单卡**：index 恒 0，按钮不出现，`prev()` 守卫同样拦住；
3. **加练续学**：词表已滤掉学过的词，「上一个」只在剩余词内回看，不会把用户带回已跳过的词。

**两个刻意的选择**：
- **不撤 `markLearned`**：走过的词就是学过了，回看只是呈现层。云端 `markLearned` 是 `_.addToSet`（幂等），重复标记无副作用；若为了「回看清进度」撤标记，用户一路退到第一个词，今日进度就空了。
- **与 `next` 共用 `locked` 连点锁**（M18）：回看途中连点不会连退两张。

**顺带确认无坑的点**：回看命中 `cardCache`（不发新请求、不等网络）、`isLast`/`nextLabel` 随 `loadCard` 重算（从末词回看按钮自动变回「下一个」）、分段进度 `buildSegs` 跟着回退、进词自动播该词发音。

**测试**：`test_learn.js` 47→**59**（12 条新断言：首词边界 / 回看行为 / 缓存命中 / 文案与分段进度 / 发音 / 不撤 markLearned / locked / review 单卡 / wxml 静态契约）。**负向验证 4 处**（回看方向、首词守卫、locked 锁、wx:if 条件：改坏后 3 处断言红、1 处进程崩 rc=1）。全量回归 **12 个文件 354 条全绿**，`check_miniprogram.js` 通过（`.btn-row`/`.ghost` 类名均有定义）。

### 12.17 第十四轮：复习文案改回「昨日」措辞（2026-10-14）

**起因**：§12.14 的 R5 把首页 CTA 改成「先复习到期的单词」，用户看到后明确
「这个应该是昨日的单词」——对用户而言，这条链路的心理模型就是「复习昨天学的单词」。

**改动**（纯前端，不部署）：

| 位置 | 改后 | 改前 |
|---|---|---|
| 首页 CTA（`index.js` `buildCta`） | 「先复习昨天的单词」 | 「先复习到期的单词」 |
| 练习页 tag（`practice.wxml`） | 「复习昨日单词」 | 「复习到期单词」 |

**取舍留档**：「到期」在两种断档场景下其实更准确（断档 N 天复习的是 N 天前的词；
昨天没新词时是历史到期词），但用户认知优先——说「到期」需要用户理解调度机制，
说「昨天」一句话就懂。判据以用户拍板为准，R5 的准确性论证在 §12.14 留档，
将来若要做「断档归来」引导文案再翻出来。

**后续（2026-10-22，D14）**：用户实测后改主意——「复习昨日单词，这个文案修改一下，
目前不是」。确实不是：复习池 = 在池未出池的词（`status='reviewing'`），正常日子也只是
昨日新词的**子集**（昨日已出池的不在內）。用户拍板去掉时间断言：

| 位置 | 终态 | 曾用 |
|---|---|---|
| 练习页 tag（`practice.wxml`） | 「复习单词」 | 「复习到期单词」（§12.14）→「复习昨日单词」（§12.17）→ 终态 |
| 首页 CTA（`index.js` `buildCta`） | 「先复习一下」 | 「先复习到期的单词」→「先复习昨天的单词」→ 终态 |
| `README.md` / `docs/intro.md` | 同步去掉「昨日」 | — |

文案三易的教训：**「昨日」和「到期」都不准确，是因为都在猜机制**；去掉时间断言的
模糊表述反而是唯一永远正确的——当准确表述需要用户理解调度机制时，不做断言优于猜一个。
`test_practice.js` 加了防回退断言（含负向验证：改回「复习昨日单词」应变红）。

### 12.18 第十五轮：形似词（2026-10-22）

**起因**：用户需求「库里的单词在学习的时候，把形似词也列出几个最多 3 个，单词/读音/翻译」。

**改动**（决策与算法见 §11.11 / D12，此处只记过程）：

- 新增 `scripts/gen_similar.py`：带状 Levenshtein（距离上限按词长 2/3/4 分档，长度差 ≤3），
  排序 (距离, -公共前缀, seq)。调试时第一版 banded 实现**带外格子填 0 不填 sentinel**，
  导致 `min()` 捡到未计算的 0，把 accommodate↔administrator 这种远词误判成近距离——
  样本抽查（council→counsel 正确）没抓到，是靠「长度差 ≤2 却出现远词」发现的。已修并加注释。
- 新增 `scripts/seed_similar.py`：逐词 update（每个词的 similar 不同，没法批量同一 data），
  4 并发 5 分钟写完 2987 条，零失败。幂等口径：缺字段才写，`--force` 覆盖。
- 学习页新增「形似词」card：点喇叭发音，**不做跳卡**——
  learn 页模式混淆是历史上最贵的 bug 类（§12.13/§12.14），不为展示价值加第四种模式。
- mock 覆盖四态（满 3 / 2 条 / 1 条 / 空数组）+ w5 故意不带字段，专测老数据降级。
- 测试踩坑一处：`api('preloadWords')` 的 `includes` 是**数组成员精确匹配**，
  两个形似词是同一次调用拼成 `preloadWords:simA,simB` 一条记录，按子串断言会假绿——
  已改为整串精确匹配并注释。
- **收尾（当天）**：按用户要求调整楼层，把「词根拆解」整块移到「形似词」上方。
  最终顺序：主卡 → 词根拆解 → 形似词 → 例句 → 单词演变。
  形似词初版在主卡之后（D12-2 原结论「紧贴单词本身对比感最强」），用户实测后认为
  应先纵向拆解本词、再横向对比形似词——原结论被推翻，仅移动 wxml 两个 card 块的顺序，
  零逻辑/零样式/零数据改动。§11.11 与 D12 已同步刷新。
- **再收尾（当天）**：按用户要求给形似词加折叠（D13）。默认收起省高度（展开态约占屏 1/4），
  收起态标题行右侧露「N 个」计数 + CSS 三角箭头，点整行切换；翻词不重置；暂缺态不参与折叠。
  实现：wxml 标题行绑 `toggleSimilar` + 内容区 `wx:if` 加 `&& similarOpen`，
  wxss 加 `.sec-title-main/.sec-count/.sec-toggle/.sec-arrow(.up)`（rotate 180° + transition），
  js data 加 `similarOpen: false`。
- **断言缺陷（值得记）**：「内容区 wx:if 带 similarOpen」的静态断言第一版写成
  `/wx:if="\{\{card.similar && card.similar.length && similarOpen\}\}"/`，
  负向验证时把 block 的条件改坏却**没变红**——正则误匹配了同区块 sec-sub 那行的同类表达式。
  已改为绑定 `<block` 前缀并复验变红。教训：同类表达式在同一区块出现多次时，
  静态断言必须锚到足够具体的上下文（标签名/前缀），否则就是假绿。
- **重大事故与恢复（当天，D14 期间）**：负向验证「复习单词」断言后用
  `git checkout -- practice.wxml` 还原，而**该文件自 v1.0 封版后从未 commit**
  （「上题下答」三代演进全是未提交改动），一记 checkout 把三代演进全部冲掉：
  `page practice` class 丢失（wxss 的 `.page.practice` 选择器静默失效）、
  off 类丢失（check 第⑦条挂）、布局注释丢失。`git diff HEAD` 为空才暴露。
  恢复路径：从历史会话 transcript（`~/.workbuddy/projects/.../5714f8b9*.jsonl`）
  提取 10-12 对 practice.wxml 的全文 Write + 两次注释 Edit + 10-15 两次 tag Edit，
  按序重放重建，check_miniprogram 五项契约复绿。
  **规程（已入 MEMORY.md 铁律）**：负向验证的还原**一律先 `cp` 到 /tmp 再改回**；
  `git checkout -- <file>` 只允许在 `git status` 确认该文件无未提交改动时使用。

### 12.19 第十六轮：复习文案去掉时间断言（2026-10-22，D14）

**起因**：用户「复习昨日单词，这个文案修改一下，目前不是」。

**改动**（纯文案，零逻辑，不部署云函数）：

| 位置 | 改后 | 改前 |
|---|---|---|
| 练习页 tag（`practice.wxml`） | 「复习单词」 | 「复习昨日单词」 |
| 首页 CTA（`index.js` `buildCta`） | 「先复习一下」 | 「先复习昨天的单词」 |
| `README.md` / `docs/intro.md` | 去掉「昨日」 | 同左 |

`test_practice.js` +1 断言（tag 无时间断言，负向验证：改回「复习昨日单词」变红 ✓）。
`git checkout` 事故与恢复见 §12.18 末条。全量回归 13 文件全绿。
### 12.20 第十七轮：练习页题干区加词根（2026-10-22，D15）

**起因**：用户「练习页面，上面是单词下面是词根，然后是选项」。

**决策**（AskUserQuestion 拍板）：词根仅加在 **cn_option**（题干是英文单词）的题干区——
en_option 题干是中文释义，露词根等于给选项送答案。数据走 `build_questions.toClient()`
下发 `roots`（用户二选一选的「改云函数」而非前端补拉：后者每套题多 5~10 次 word_card 往返）。

**改动**：
- `cloudfunctions/build_questions/index.js`：`buildQuestion` 带 `roots: w.roots || []`（随题存进
  daily_plans，新题自带）；`toClient` 下发 `roots: Array.isArray(q.roots) ? q.roots : []`
  —— **复用分支的旧队列没有该字段，兜底 []**，前端不渲染（可选内容，允许缺失）。
- `practice.wxml`：题干区三层化 = 单词/音标 → `q-roots`（`wx:if="{{q.type === 'cn_option' && q.roots && q.roots.length}}"`）→ 选项。
- `practice.wxss`：`.q-roots/.q-root-item/.q-root-part/.q-root-type/.q-root-meaning`，
  视觉与 learn 页词根对齐但收紧一档（题干区还要给 flex:1 留呼吸空间）。
- `mock.js`：QUESTIONS 覆盖三态——cn_option 带词根 / en_option 不带 / 空数组（旧题态）。
- 测试：`test_build_questions.js` +3（下发 roots、原样透传、复用分支兜底 []）；
  `test_practice.js` +3 静态（词根块位置、仅 cn_option、wx:key）。负向验证 2 处
  （toClient 删 roots 字段 → 红；wxml 删 type 守卫 → 红）。全量 13 文件 396 断言全绿。

**⚠️ 部署提醒**：本轮要部署 `build_questions`（IDE 上传）。前端先发布而函数忘部署时，
旧题照样能跑（roots 缺失只是不展示词根）——与 answerIndex 缺字段会卡死的性质不同，
这条降级是安全的。

**收尾（当天傍晚）**：用户实测截图发现加练组旧队列仍不显示词根。根因：旧版
`build_questions` 生成的 daily_plans 队列题目没有 `roots` 字段，而复用分支
（`existing` 非空即原样返回）会一直 Serve 旧队列。处置：新增
`scripts/backfill_queue_roots.py` 按 wordId 从 words 回填 roots——**逐题点路径
update（`practiceQueue.0.roots`）**，不整数组重写（`submit_answer` 是整数组读改写，
重写会冲掉用户答题进度）；默认只处理今天（`build_questions` 只读今天的计划），
`--all-dates` / `--force` 可选。今日计划 15 题已补齐（legislation 3 条）。
⚠️ 仍须部署 `build_questions` 才对用户可见：旧版 `toClient` 根本不下发 roots。
