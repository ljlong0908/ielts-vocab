# 雅词本 — 项目结构与业务逻辑说明

> **文档用途**：供 AI 或其他协作者快速理解本项目的**目录结构**与**业务逻辑**，作为上下文注入。
> **权威性**：本文档以**源码为准**（`miniprogram/` + `cloudfunctions/`）。设计阶段的历史稿（曾提到 Vant / 微信同声传译插件，均未采用）已于 2026-09-28 清理，**以本文档为准**。
> **最后核对**：2026-09-28（完成死代码清理、数据表初始化函数、部署文档，以及项目瘦身与词表清洗，详见 §11）。

---

## 1. 项目概览

| 项 | 值 |
|---|---|
| 产品名 | 雅词本（工程代号 `ielts-vocab`） |
| 形态 | 微信小程序（原生，非 uni-app/Taro） |
| 定位 | 雅思词汇**每日学习闭环**工具 |
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
- **前端**：只做渲染、交互、云函数调用、音频播放；不持有任何密钥；不直接写数据库。
- **云函数**：所有写操作、AI 调用、内容安全、并发锁、判题都在服务端完成。
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
│   ├── build_wordlist.py         # 从 ECDICT 抽雅思词表 → assets/word_lists/*.json
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
    ├── build_questions/          # 生成双向题型题目（答案留服务端）
    ├── submit_answer/            # 服务端判题 + 复习推进
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
| 3 | `today_flow` | `{}` 或 `{action:'markLearned', wordId, round?}` | `{plan,dailyGoal,streak,totalLearned,extra}` | **前端唯一状态来源**。首次进入创建当日 plan：有待复习→`review`，否则→`learning`；若今日已打卡则强制 `stage='done'`（只改内存，不落库）。`markLearned` 轻量累加 `learnedIds`；`round>0` 时改累加**该加练组**的 `learnedIds`。`extra` = `{canStart,exhausted,limitReached,pendingRound,roundsToday,extraLearnedToday,groupSize}`，供首页「再学一组」按钮决策；返回的 `plan.extraRounds` 已剥掉 `practiceQueue`（避免答案下发） |
| 4 | `start_new_words` | `{}` | `{newWordIds,reused,exhausted}` | **幂等**生成当日新词：若 plan 已有 newWordIds 直接复用；否则按 `seq > wordCursor` **且 `audioReady === true`** 的顺序取 `dailyGoal` 个。✅ 没音频的词不会出（见 7.3） |
| 5 | `word_card` | `{ wordId }` | 单词卡文档 + `enriching` | 读词；`enriched=false` 时**同步调用** `enrich_word` 再读一次；仍失败则返回基础字段 + `enriching:true` |
| 6 | `build_questions` | `{ phase:'review'\|'practice', round? }` | `{questions,reused}` | 生成题目（**先查缓存复用**）。`round>0` 时读写 `extraRounds[round-1].practiceQueue`、词源取该组 `wordIds`（**C4**：不加 round 会覆盖 `plan.practiceQueue`）。题型 `i%2` 交替 cn_option/en_option，再 shuffle；干扰项从**非本批**词库随机取 3 个；答案存服务端，下发前 `sanitize` 剔除 |
| 7 | `submit_answer` | `{ phase, questionIndex, choice, round? }` | `{correct,answerIndex,wordId,word,meaning,phaseDone}` | 服务端判题；写 `records`；推进 `user_words` 复习状态；`round===0` 时全对推进 `plan.stage`，`round>0` 时只更新组内队列与组 `stage`（**C3**：绝不写 `plan.stage`） |
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
| 18 | `dismiss_wrong` | `{ wordId }` | `{wordId,updated}` | **错题本「已掌握」**（用户追加，非原型项）。把该用户该词的**所有答错记录**打 `mastered:true`（`updated` = 命中条数），`stats` 随即不再下发该词。**⚠️ 不删流水**（见 §4.5 `records.mastered` 的取舍说明）；幂等——重复标记只是重写同一个值，无副作用，故不额外加「未标记」条件（少一个 `where().update()` 的 command 不确定项） |

---

## 6. 前端页面（共 8 个）

| 页面 | 路径 | 数据来源（云函数） | 关键行为 |
|---|---|---|---|
| 首页 | `pages/index` | `home_summary` + `today_flow` | 计算进度百分比；按 `stage` 生成 CTA 文案与跳转目标；未 `onboarded` 则 redirect 到 onboarding；底栏另挂「再学一组」按钮（**仅当日已打卡后显示**，读 `today_flow.extra`）。显隐优先级：**有未完成组（`pendingRound`）→ 必显示且文案「继续学一组」（优先于上限判断）** ＞ `exhausted`/`limitReached` → 显示但置灰 + 底栏说明原因 ＞ 正常 → 可点。⚠️ **不得静默隐藏**（见 §11.13） |
| 引导 | `pages/onboarding` | `user_profile(setGoal)` | 选 5/10 → 写目标 + `wx.setStorageSync('onboarded',true)` → reLaunch 首页 |
| 单词卡 | `pages/learn` | `today_flow` / `start_new_words` / `word_card` / `today_flow(markLearned)` | 逐张卡片；**进词自动播单词发音**；**预取下一张**触发 AI 生成；`next()` 时 `markLearned`（带连点锁）；最后一张跳 `practice?phase=practice`；单词/例句发音。**`?round=N` 为加练模式**：词源取 `plan.extraRounds[N].wordIds` 并**跳过该组已学过的词**（按 `learnedIds`，剩余为空则直接跳小测）、「加练单词」标签、`markLearned` 带 round。**`?review=<wordId>` 为错题复习（W2）**：词源**只来自参数**，单卡、「错题复习」标签、按钮「复习完成」→ `navigateBack` 回错题本；**不读 `today_flow`、不调 `start_new_words`、不写 `markLearned`**（否则点一下错题本就会推进当日游标、污染今日进度） |
| 练习 | `pages/practice` | `build_questions` / `submit_answer` / `finish_extra_round` | `phase` 由 URL 参数决定；答对自动进下一题（900ms），答错标错并**禁用该选项要求重选**；答对播放发音；review 全对跳 learn，practice 全对跳 checkin。**`?round=N` 为加练**：出题/判题带 round，全对后 `finish_extra_round` 再 `switchTab` 回首页 |
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
> 少了它，加练会写进主队列与主讲度（后端任务单里的 C2/C3/C4 三个静默破坏点）。
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

### 7.4 复习调度（简化版，预留升级位）
- 待复习集合：`user_words` 中 `status != mastered` **且** `nextReviewDate <= today`，上限 50 条。
- **答对时**（review 阶段）：
  - `clean = !本次答错 && 历史 wrongCount === 0` → `status='mastered'`，`nextReviewDate=''`
  - 否则 → `status='reviewing'`，`nextReviewDate = 明天`（继续留存复习）
- **答错时**：`wrongCount+1`，`status='reviewing'`，`nextReviewDate = 明天`。
- 新学词在打卡时注册进复习池：`status='reviewing'`，`nextReviewDate = 明天`，`round=1`。
- > 未实现完整艾宾浩斯/FSRS，`round` 字段为 v2 预留。

### 7.5 题型生成与服务端判题
- **两种题型**：`cn_option`（中选项：题干英文单词→选中文释义）/ `en_option`（英选中：题干中文释义→选英文单词）。
- 同一批题目按 `i % 2` **交替**分配题型，再整体 shuffle 混合。
- **干扰项**：从**不在本批**的词库中随机取 3 个（`_id nin wordIds` 的池，池不足 3 则放宽到全库）。
- **题干**：cn_option 用 `w.word` 且带音标；en_option 用 `w.meaning`。
- **答案不下发**：题目携带 `answerIndex` 存 `daily_plans`，`sanitize()` 后只下发 `{id,wordId,type,stem,phonetic,options}`。
- **判题**：`submit_answer` 服务端比对 `choice === answerIndex`；答错**不移除题目**，前端禁用该选项要求重选，直到答对。

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

### 7.9 发音（离线预生成音频 + 前端 fileID 缓存）
```
playWord(word)
  ① 前端 wx.storage 查 fileID ──命中──▶ 秒播（不联网、不调云函数）
  ② 未命中 → callFunction(audio_cache)
        └─ 查 audio_cache 集合 {text,type} ──命中──▶ 返回云存储 fileID → 存前端缓存 → 播放
        └─ 未命中 → 下载 dictvoice → 上传云存储 → 写索引 → 返回 fileID   ← 仅词表外单词会走到这里
  ③ 云函数失败 → 降级直播 dictvoice URL（不缓存）
```
- **主音源是云存储里的离线音频**，由本地 `scripts/gen_audio.py` 用 **Kokoro-82M（Apache-2.0）** 批量合成，**当前先只做美音**（type=2，voice=`af_heart`，lang_code=`a`）——因为前端 `config.TTS_LANG='en_US'` 映射出的就是 type 2，足够覆盖全部播放场景；英音（type=1）留到将来做「英美音切换」时用 `--types uk` 增量补。mp3 约 5KB/词。经 `seed_audio` 上传并写入 `audio_cache` 索引后，运行时**零第三方外呼**。
- `audioReady` 机制保证学习流程里出现的词都已有音频，故第 ② 步的 dictvoice 分支实际不会触发；保留它主要为词表外单词兜底。
- 音频全部自持后，可**移除** downloadFile 合法域名 `https://dict.youdao.com`。
- 缓存键：前端 `audio_cache_{type}_{text}`，`text` 为单词或整句；`audio_cache` 集合跨用户共享。
- 云存储路径有两种，别混：**预置音频**是 `audio/{type}/{slug}.mp3`（单词）与 `audio/{type}/s_{hash}.mp3`（例句，见 7.8）；**dictvoice 兜底**落盘为 `audio/{type}_{hash}.mp3`。两者互不影响，排查时按来源看 `audio_cache.source`（`preseed` / `dictvoice`）。
- `playSentence(text)`：播放**整句音频**（本地 Kokoro 预生成，见 7.8 例句流水线）。走 `resolveSrc(text, type, 'sentence')` → 以**整句文本**为 key 查 `audio_cache` → 命中即播。**无 dictvoice 兜底**（实测整句请求 dictvoice 返回 HTTP 500 / 120 字节 JSON，必失败）；云函数返回 `NOT_PRESEEDED` 时**静默不播** —— 补音频是渐进的，期间大量例句尚无音频，弹提示会持续打扰学习。早期的「逐词链式朗读」实现已废弃（听感生硬）。
- `playWord(word)` 的调用方：① learn 页 —— **进入每个单词页自动播一次**（`loadCard()` 里 `setData` 之后调，首个词与「下一个」共用同一入口）+ 喇叭按钮手动重播；② 将来练习/复习页如需可复用。自动播放在 `setData` 之后触发，保证「词先出现、再出声」；连点由 `locked` 挡住，`playSrc` 内部先 `ctx.stop()` 也不会叠音。
- `playSentence` 的**两个调用方**都要在这里对号：① learn 页单词卡的例句（见 7.8 例句流水线）② 首页「每日一句」（见 7.8 每日一句流水线，12 句已全部预置）。**任一路径新增句子而没补音频，症状都是「静默不播」**，排查先查 `audio_cache` 有无该整句文本。
- ⚠️ **`cloud://` fileID 不能直填 `InnerAudioContext.src`（真机截断坑）**：开发者工具里正常，
  真机上会**播放中途截断**（实测：每日一句第一次播两个词就停，第二次点因内部缓存才完整）。
  `resolveSrc` 最后一步用 `wx.cloud.getTempFileURL` 把 fileID 转成 https 临时链接再交给播放器，
  内存缓存 100 分钟（临时链接有效期 2h），转换失败降级回 fileID（宁可冒截断风险也不哑掉）。
  回归：`scripts/test_audio.js`（9 条，含转换/缓存/透传/降级四条路径）。
- 停止：`stop()` 中断并清事件监听。
- 配置：`config.TTS_LANG` 映射 type（`en_US`→2，`en_GB`→1）。

### 7.10 日期与时区
- 云函数统一 `dateStr(offset)`：`Date.now() + 8h` 后取 UTC 部分格式化 `YYYY-MM-DD`（即 **GMT+8** 自然日）。
- 前端 `stats` 页日历用**本地时间** `new Date()` 生成——理论上两端时区应都为 GMT+8，无差异。

### 7.11 分享转发（`utils/share.js`）
- 8 个页面**全部**实现 `onShareAppMessage()`，内容由 `share.toFriend(opts)` 统一生成，缺省标题 `雅词本｜每天记住几个雅思词`。
- **分享路径统一回首页** `pages/index/index`（含 learn / practice / checkin 等强流程页）。原因：新用户从卡片直接进入流程页会立刻创建当日学习计划，体验突兀；回首页最干净，未设置目标的新用户由 index 自动引导到 onboarding。
- 部分页面用**上下文文案**增强信息量：`learn` 带当前单词、`checkin` 带连续天数、`stats` 带累计词数、`wrongbook` 带错题数；数据缺失时回落到默认文案。
- **不启用朋友圈（`onShareTimeline`）**：朋友圈进入的是「单页模式」——无登录态、不允许跳转，云开发必须开启「未登录访问」才能读到数据；本项目数据全部依赖 openid，单页模式必然空白，而放开未登录访问会带来越权读写风险。**除非将来专门做一个不依赖登录的内容页，否则不要开。**
- 打卡成功页（`checkin.wxml`）内置 `<button open-type="share">分享给朋友</button>`，是唯一的前端显式分享入口。
- 分享卡片配图：`share.js` 中 `SHARE_IMAGE` 常量，默认留空（用系统页面截图 + 小程序 Logo）。如需自定义，新建 `miniprogram/images/` 并放图（建议 5:4 / 500x400），再把常量改成 `/images/share.png`——**图片必须在 `miniprogramRoot` 内才会被打包**（`assets/` 在包外，放那里不会生效）。
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
| 答案安全 | 题目答案存服务端，下发前剔除 |
| 防重复 | `start_new_words` / `build_questions` / `finish_checkin` 均幂等 |
| 集合权限 | `words` 建议「所有用户可读，仅管理端可写」，其余「仅创建者可读写」 |
| 超时 | 20s：`user_profile`/`home_summary`/`today_flow`/`start_new_words`/`submit_answer`/`audio_cache`；30s：`word_card`/`enrich_word`/`build_questions`/`finish_checkin`/`stats`/`start_extra_round`/`finish_extra_round`；60s：`seed_words`/`seed_audio`/`reset_words`/`init_db`；**10s：`dismiss_wrong`**（一次数据库 update，无外部依赖）。均由各函数 `config.json` 声明，部署后可在控制台核对 |
| 分享 | 只用 `onShareAppMessage`（转发给朋友/群），路径统一回首页；**不开朋友圈**（单页模式无登录态，云开发读不到数据） |
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

---

## 10. 快速定位索引（改需求看这里）

| 想改什么 | 去哪个文件/函数 |
|---|---|
| 每日目标选项（5/10） | `miniprogram/config.js` `DAILY_GOAL_OPTIONS` + `user_profile` |
| 出词顺序/策略 | `cloudfunctions/start_new_words/index.js`（`seq` + `wordCursor` + `audioReady`） |
| 复习调度逻辑 | `cloudfunctions/submit_answer/index.js`（correct 分支） |
| 题型比例/干扰项 | `cloudfunctions/build_questions/index.js`（`i % 2`、`sample(pool,3)`） |
| AI Prompt / 模型 | `cloudfunctions/enrich_word/index.js`（`buildPrompt` / `callModel`） |
| 发音音源（单词） | `scripts/gen_audio.py`（本地生成）→ `cloudfunctions/seed_audio`（上传+点亮）→ `miniprogram/utils/audio.js`（`resolveSrc` / `fallbackUrl`）/ `cloudfunctions/audio_cache`（读缓存） |
| **数据表初始化 / 建索引** | `scripts/init_cloud.py`（本地走 HTTP API，建集合 + 建索引，清单在 `assets/db-indexes.json`）；控制台备选 `cloudfunctions/init_db`（建集合 + 返回索引清单） |
| **部署步骤 / 报错排查** | `docs/deploy.md` |
| 例句文本来源 | 运行时：`cloudfunctions/enrich_word`（`buildPrompt`）；离线批量：`scripts/gen_examples.py` |
| 发音音源（例句） | `scripts/gen_examples.py` → `scripts/gen_sentence_audio.py`（本地生成，`s_{hash}`）→ `seed_audio`（`kind:'sentence'` 上传）→ `audio.js` 的 `playSentence` / `audio_cache`（**只读不写**） |
| 发音音源（每日一句） | `scripts/quotes_to_examples.py` → `gen_sentence_audio.py` → `scripts/seed_quote_audio.py`（上传 + 写 `audio_cache`，**不走 seed_audio 云函数**）；播放复用 `audio.js` 的 `playSentence` |
| 每日一句语料 | `miniprogram/utils/quotes.js`（静态、按日取模轮换，零后端；`utils/mock.js` 的 `DAILY_LINES` 与此同源） |
| 词表来源 / 筛选 / 归一 | `scripts/build_wordlist.py`（ECDICT → `assets/word_lists/ielts-full.json`；基础词排除 + 专名剔除 + 名词复数归一，规则全部固化为脚本常量） |
| 词表导入入参打包 | `scripts/pack_words.py` → `build/seed_words/batch-*.json` |
| 音频入参打包 | `scripts/pack_audio.py` → `build/seed_audio/` 或 `build/seed_sentence/` |
| 分享标题/路径/配图 | `miniprogram/utils/share.js`（`toFriend`），各页 `onShareAppMessage()` |
| 状态机流转 | `cloudfunctions/today_flow` + `submit_answer` + `finish_checkin` |
| **错题本「已掌握」（移出错题本）** | `cloudfunctions/dismiss_wrong/index.js`（给 `records` 打 `mastered` 标）+ `stats/index.js`（错题查询排除 `mastered:true`）+ `pages/wrongbook/wrongbook.js`（`markMastered`，乐观移除 + 失败回滚） |
| 页面跳转 | 各 `pages/*/index.js`（`wx.navigateTo`） |

---

## 11. 整理记录（2026-09-28）

### 11.1 删除的死代码（均先核验零引用）

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

### 11.2 合并与优化

- `home_summary`：去掉 `totalCheckins` 的额外 `count()` 与无人读的 `stage` 字段 —— 每次进首页省一次 DB 往返
- `utils/audio.js`：抽出 `playSrc()`，单词与例句共用「停 → 清监听 → 设源 → 播放 → 挂 onError」，消除两处重复（原单词版还漏了 `offEnded`，与例句版不一致）
- `utils/share.js`：只导出 `toFriend`（`HOME_PATH` / `BRAND` 无外部引用）
- **品牌素材移出小程序包**：`雅词本-头像-1024.png` / `-144.png` / AI 原始图标 → `assets/brand/`。原位置在 `miniprogramRoot` 内会被打进包（约 0.8MB），且代码零引用
- **统一依赖版本**：`audio_cache` 的 `wx-server-sdk` `latest` → `~2.6.3`、`axios` `^1.6.0` → `^1.6.8`（与其余 14 个函数一致）
- **补齐 8 个缺失的 `config.json`**：`user_profile` / `home_summary` / `today_flow` / `start_new_words` / `build_questions` / `submit_answer` / `finish_checkin` / `stats`。此前超时值只能靠控制台默认，现在随代码声明

### 11.3 新增

- `cloudfunctions/init_db` —— 数据表体检 / 初始化（幂等），顺带返回手工索引清单
- `docs/deploy.md` —— 从零到可用的部署清单（含验收表、报错排查表、提审检查表）

### 11.4 有意保留（勿删，附理由）

- `audio_cache` 的 dictvoice 兜底分支与前端 `fallbackUrl`：词表外单词的能力。`audioReady` 机制保证学习流程不会触发它
- `cloudfunctions/seed_words/words.json`：被 `seed_words/index.js` 实际 `require` 的内置 24 词示例
- 各云函数独立的 `ADMIN_TOKEN` 读取块：环境变量是**函数级隔离**的，代码虽重复但无法共享
- 跨运行时的 `hashText` / `TEXT_RE*` / `slug` / `sentence_slug`：JS 与 Python 无法共享代码，**只能靠同步**。改动其中一处后务必跑 `scripts/make_audition_page.py` 预检（它会校验正则与文件头）
- 各函数内注释掉的 `nickname` / `avatarUrl`：合规说明（证明「未接入授权、不收集」）

### 11.5 第二轮：项目瘦身与词表清洗（2026-09-28）

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

**问题**：ECDICT 的 `ielts` 标签里混入专名（雅思阅读听力里出现过，就被打上标签）。它们朗读没问题，但作为「词汇」毫无学习价值，还挤占学习队列——`york` 因 `New York` 语料频次极高，被按 BNC 排到了**第 48 位**，等于让用户很早就学一个人名/地名。

**判据**（取自 ECDICT 自身的两个字段，在合格候选池上命中 5 个、**0 误报**）：

| 规则 | 判据 | 命中 |
|---|---|---|
| A | 中文释义的括号注释是「地名/姓氏/王朝」类标记 | `sydney`（澳大利亚港市）、`forbes`（美国出版及媒体集团）、`tours`（姓氏）、`wollongong`（澳大利亚东南部港市） |
| B | 英文释义是地名 / 王室的**指认句式** | `york`（the English royal house … reigned from）、`sydney`（the largest Australian city located in …） |

两条都刻意收紧过：早期宽松写法（任何含 `city` / `town` / `state` 的释义）命中 **106** 个，绝大多数是 `the state of being …` 这类正常释义，**不可用**。

**逃生舱**：`KEEP_PROPER_LOOKING` —— 万一将来 ECDICT 更新后某个正经词被规则命中，加进去即可放行，无需改判据；`PROPER_NOUNS` 里的显式清单同时作为判据的兜底，词表重建时会打印全部被剔除的专名，并对「列在清单里但已不再命中判据」的条目报警，便于复核。

**注意**：`guy`（seq 270）**不是专名**，已保留——柯林斯 4 星、牛津 3000 核心词、有完整词形变化（`guys` / `guyed` / `guying`），释义「家伙」是正经的常用义。

**连带影响**：`york` 原本在 48 位，剔除后 pilot-100 由「`york`」换成「`discipline`」（原第 101 位），其余 99 词不变；`assets/examples/pilot-100-examples.json` 与 `build/` 下的音频、入参批次已同步重建。（`discipline` 在第三轮又因排序重排移出 pilot-100，见 §11.6。）

> ⚠️ **破坏性语义**：若云端已导入过任何旧词表（3056 / 3041 / 3036 词），必须用 `reset_words`（`purge`）清空后重导，**不能**直接 `seed_words` —— 它按 `word` 去重跳过，`wheels` / `jobs` 这类已删词会留在库里。

#### 新增

- `scripts/pack_words.py` —— 把词表打包成 `seed_words` 入参：按 `--batch-size`（默认 200 词）切分，每批是一份**完整可用**的入参（约 38KB，控制台入参框吃得下），并产出 `index.json` 清单（含每批词数与首末词）。此前导词表只能手搓 JSON，或用 `offset/limit` 反复粘贴整份词表
- `docs/deploy.md` 新增 **§0.1 老环境升级增量清单**（哪些云函数要重部署、词表为什么要先 purge）

### 11.6 第三轮：名词复数归一（2026-09-28）

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

### 11.7 第四轮：数据库初始化本地化（2026-09-29）

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

### 11.8 第五轮：数据导入也本地化，初始化全流程一条命令（2026-09-29）

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

### 11.9 第六轮：每日一句补音频（2026-09-29）

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

### 11.10 第七轮：错题本「已掌握」（2026-09-29）

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


### 11.11 第八轮：错题本点词进复习（2026-09-29）

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

### 11.12 第九轮：加练计入「累计学习」（2026-09-29）

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

### 11.13 第十轮：加练按钮「中途退出被锁死」（2026-09-29）

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
