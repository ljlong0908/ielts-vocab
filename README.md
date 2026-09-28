# 雅思词汇微信小程序（MVP）

帮助用户每日积累雅思词汇的微信小程序。核心闭环：**微信登录 → 设置每日目标 → 先复习昨日单词 → 学今日新词 → 做题练习 → 全对打卡 → 次日循环**。

技术底座：**微信云开发 CloudBase**（云函数 + 云数据库 + 云存储），无需自建服务器。

📌 **部署请直接看 [`docs/deploy.md`](docs/deploy.md)** —— 逐步操作以那份文档为准，本文只做概览与背景说明。

文档索引：

- [`docs/deploy.md`](docs/deploy.md) —— **部署与上线步骤**（从零到可用，含验收表 / 报错排查 / 提审检查）
- [`docs/project-spec.md`](docs/project-spec.md) —— 项目结构与业务逻辑说明（**以源码为准**，供 AI 作为上下文）
- [`docs/隐私保护指引.md`](docs/隐私保护指引.md) —— 隐私合规文案
- `specs/ielts-vocab-miniprogram/requirements.md` —— PRD（EARS 验收标准，范围基准）
- `specs/ielts-vocab-miniprogram/design.md` —— ⚠️ 设计阶段历史稿（提到 Vant / 同声传译插件，均未采用）

---

## 目录结构

```
ielts-vocab/
├── project.config.json          # 项目配置（需填 appid）
├── README.md / LICENSE / .gitignore
├── specs/                       # 需求与技术方案（PRD；design.md 为历史稿）
├── docs/                        # deploy.md（部署步骤）/ project-spec.md（业务逻辑）/ 隐私保护指引
├── assets/
│   ├── brand/                   # 品牌素材（头像 / 图标源文件；在 miniprogramRoot 之外，不进小程序包）
│   ├── word_lists/              # 词表源文件（ECDICT 抽取结果 + 其 MIT 许可证副本）
│   └── examples/                # 离线生成的例句 JSON（词表级资产，随仓库保留）
├── scripts/                     # 离线工具链：取词表 → 生成发音/例句 → 打包上传（不进小程序包）
│   ├── build_wordlist.py        # 从 ECDICT 抽雅思词表
│   ├── gen_audio.py             # Kokoro 本地批量合成**单词**发音（默认只做美音 --types us）
│   ├── gen_examples.py          # DeepSeek 离线批量生成例句（含 roots/etymology）
│   ├── gen_sentence_audio.py    # Kokoro 本地批量合成**例句**发音（hash 命名）
│   ├── install_spacy_model.py   # 装 en_core_web_sm（不在 PyPI，走 HF 镜像）
│   ├── make_audition_page.py    # 本地预检 + 生成音频试听页（单词/例句通用）
│   ├── pack_audio.py            # 打包成 seed_audio 的入参数（单词/例句通用）
│   ├── fill_token.py            # 批量把 batch-*.json 的 __ADMIN_TOKEN__ 换成真实密钥
│   └── requirements.txt
├── miniprogram/                 # 小程序前端
│   ├── app.js / app.json / app.wxss
│   ├── config.js                # ⚠️ 需填云环境 ENV_ID
│   ├── utils/
│   │   ├── api.js               # 云函数调用封装
│   │   ├── audio.js             # 发音：前端 fileID 缓存 → 云存储 → 单词走 dictvoice 兜底
│   │   └── share.js             # 分享转发统一配置
│   └── pages/
│       ├── index/               # 首页：进度、连续打卡、入口
│       ├── onboarding/          # 首次设置每日 5/10
│       ├── learn/               # 单词卡（单词/音标/发音/例句/词根/词源）
│       ├── practice/            # 练习（中选项 + 英选中，带发音）
│       ├── checkin/             # 打卡结果
│       ├── stats/               # 统计 + 打卡日历
│       ├── wrongbook/           # 错题本
│       └── profile/             # 我的 / 目标设置
└── cloudfunctions/              # 云函数
    ├── user_profile/            # 登录 / 设置目标
    ├── home_summary/            # 首页聚合
    ├── today_flow/              # 当日流程状态编排
    ├── start_new_words/         # 幂等生成当日新词队列（只取 audioReady=true 的词）
    ├── word_card/               # 单词卡（含 AI 补全 + 缓存）
    ├── build_questions/         # 生成双向题型
    ├── submit_answer/           # 服务端判题 + 复习推进
    ├── finish_checkin/          # 打卡 + 注册复习池（wordCursor 按 seq 推进）
    ├── stats/                   # 统计 + 错题
    ├── audio_cache/             # 音频读缓存：查库命中直接返回 fileID
    ├── enrich_word/             # AI 补全（乐观锁 + 定时重试）
    ├── seed_words/              # 词表导入（管理用，按 word 去重跳过）
    ├── seed_audio/              # 音频入库 + 点亮 audioReady（管理用）
    ├── reset_words/             # 词库重置（管理用，⚠️ 破坏性，带预检+二次确认）
    └── init_db/                 # 数据表体检 / 初始化（管理用，幂等；返回手工索引清单）
```

---

## 快速开始

### 1. 准备

- 注册小程序，拿到 **AppID**（[mp.weixin.qq.com](https://mp.weixin.qq.com)）
- 安装 **微信开发者工具**

### 2. 导入项目

用微信开发者工具「导入项目」，选择本目录，填入你的 AppID。  
（或直接编辑 `project.config.json` 的 `appid` 字段）

### 3. 开通云开发

工具顶部「云开发」→ 开通 → 创建环境 → 复制**环境 ID**。

把它填到 `miniprogram/config.js`：

```js
ENV_ID: '你的环境ID'
```

### 4. 部署云函数（共 15 个）

在 `cloudfunctions/` 下对**每一个**函数目录右键 →「上传并部署：云端安装依赖」（不要选「上传所有文件」，否则依赖不装）。

> ⚠️ **超时设置（必看）**：微信云开发云函数**默认超时只有 3 秒**，而调用大模型通常要 5–15 秒。
> 现在**每个函数都有自己的 `config.json`** 声明超时，部署时会自动带上：
>
> | 超时 | 函数 |
> | --- | --- |
> | 20s | `user_profile` / `home_summary` / `today_flow` / `start_new_words` / `submit_answer` / `audio_cache` |
> | 30s | `word_card` / `enrich_word` / `build_questions` / `finish_checkin` / `stats` |
> | 60s | `seed_words` / `seed_audio` / `reset_words` / `init_db` |
>
> 部署后仍建议到控制台 → 云函数 → 「配置」**核对一次**；若显示 3 秒，按上表手改。
>
> `enrich_word` 与 `audio_cache` 依赖 `axios`，务必选「云端安装依赖」。

### 5. 配置云函数环境变量（关键）

本项目用 **DeepSeek** 生成例句 / 词根 / 词源。

1. 去 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 注册 → 「API keys」→ 创建，复制 `sk-` 开头的 Key（**只显示一次**，注意保存）；
2. 去「充值」页充值（DeepSeek 无免费额度，最低 10 元起，全词库生成约几元）；
3. 云开发控制台 → 云函数 → `enrich_word` → 配置 → **环境变量**，新增：

| 变量名                   | 说明                         | 示例                                             |
| --------------------- | -------------------------- | ---------------------------------------------- |
| `DEEPSEEK_API_KEY`    | DeepSeek API Key（**必填**）   | `sk-xxxxxxxx`                                  |
| `DEEPSEEK_MODEL`      | 模型名（可选，默认 `deepseek-chat`） | `deepseek-reasoner`                            |
| `DEEPSEEK_ENDPOINT`   | 接口地址（可选）                   | 默认 `https://api.deepseek.com/chat/completions` |
| `DEEPSEEK_TIMEOUT_MS` | 单次调用超时（可选，默认 30000）        | `30000`                                        |
| `ADMIN_TOKEN`         | **管理密钥（建议配置）**，用于锁住「管理类」能力 | `openssl rand -hex 24` 生成                      |

**关于 `ADMIN_TOKEN`** —— 云函数是**对全体小程序用户开放的接口**，前端可以伪造任意入参调用任意函数，所以管理类能力必须额外加锁。生效于**五个函数**（环境变量是**函数级隔离**的，同一名字必须在每个函数上分别配置，值保持一致）：

| 函数            | 未配 `ADMIN_TOKEN` 时                          | 配了之后                               |
| ------------- | ------------------------------------------- | ---------------------------------- |
| `enrich_word` | `force: true` 被忽略（无法强制重生成，缓存永远生效）           | 传 `_token` 才允许 `force: true` 强制重生成 |
| `seed_words`  | **拒绝一切调用**（返回 `ADMIN_TOKEN_NOT_CONFIGURED`） | 入参带 `_token` 才能导入词表                |
| `seed_audio`  | **拒绝一切调用**（返回 `ADMIN_TOKEN_NOT_CONFIGURED`） | 入参带 `_token` 才能上传音频                |
| `reset_words` | **拒绝一切调用**（返回 `ADMIN_TOKEN_NOT_CONFIGURED`） | 入参带 `_token` 才能清空词库（还需 `confirm: "PURGE"`） |
| `init_db`     | **拒绝一切调用**（返回 `ADMIN_TOKEN_NOT_CONFIGURED`） | 入参带 `_token` 才能建数据表                |

**自查某个函数到底配没配**（不用翻控制台）：故意传一个错的 token 调它，看报错文案——
- 返回 `ADMIN_TOKEN_NOT_CONFIGURED` → 该函数**没配**环境变量
- 返回 `INVALID_ADMIN_TOKEN` → 已配置，只是 token 传错了
- 正常返回 → 配置正确


> 生成随机密钥：终端执行 `openssl rand -hex 24`，把输出粘进环境变量即可。**别用弱口令，也别和 DeepSeek Key 相同。**

两个模型怎么选：

- `deepseek-chat`（DeepSeek-V3）—— **默认，推荐**。响应快、便宜，词根词源这类任务够用；
- `deepseek-reasoner`（DeepSeek-R1）—— 推理更强但慢且贵，词源解释质量提升有限，不建议 MVP 阶段用。

> 代码已开启 DeepSeek 的 **JSON Output**（`response_format: json_object`），模型会直接返回合法 JSON，不必担心解析失败。  
> 想换成别家模型也行：只要兼容 OpenAI Chat Completions 协议，改 `DEEPSEEK_ENDPOINT` + `DEEPSEEK_MODEL` + Key 三个环境变量即可，代码不用动。  
> ⚠️ **API Key 只配在云函数环境变量里，绝不要写进 `miniprogram/` 下的任何前端文件**——小程序包体可被反编译。

### 6. 初始化数据表（`init_db`）

集合必须先「存在」才能读写，否则云函数会直接抛 `Db not exist`。项目提供 `init_db` 云函数一键建表（**幂等**，可重复执行）。

**① 体检** —— 控制台 → 云函数 `init_db` → 云端测试：

```json
{ "_token": "你的 ADMIN_TOKEN", "mode": "preview" }
```

返回 `data.collections` 会逐个列出集合是否存在及当前文档数，`data.missing` 是还缺的那些。

**② 建表**

```json
{ "_token": "你的 ADMIN_TOKEN", "mode": "create" }
```

`data.created` 是本次新建的集合；`data.missing` 应为空、`data.ready` 为 `true`。

**③ 手工建索引** —— ⚠️ 云开发 SDK **只能建集合、不能建索引**，这一步只能到控制台做：控制台 → 数据库 → 选中集合 → 索引管理 → 添加。`init_db` 返回体的 `data.indexes` 就是这份清单：

| 集合 | 索引字段 | 唯一 | 用途 |
| --- | --- | -- | --- |
| `users` | `_openid` | 是 | 登录查用户 |
| `words` | `word` | 是 | 导入去重 / 音频点亮按词名匹配 |
| **`words`** | **`audioReady` + `seq`** | 否 | **★ 出词性能关键**（`audioReady=true` 且 `seq` 递增） |
| `user_words` | `_openid` + `wordId` | 是 | 学习状态读写 |
| `user_words` | `_openid` + `status` + `nextReviewDate` | 否 | 复习池查询 |
| `daily_plans` | `_openid` + `date` | 是 | 当日计划唯一 |
| `records` | `_openid` + `date` | 否 | 答题记录按日查 |
| `records` | `_openid` + `isCorrect` | 否 | 错题本 |
| `checkins` | `_openid` + `date` | 是 | 打卡幂等 |
| `audio_cache` | `text` + `type` | 是 | 音频索引唯一 |

**④ 安全规则** —— 控制台 → 数据库 → 集合 → 权限设置：

- `words` → **所有用户可读，仅管理端可写**
- 其余全部 → **仅创建者可读写**

### 7. 导入词库与生成发音

词表与发音音频都是**离线预生成**再导入的，运行时零第三方调用。整条链路由 `scripts/` 下的三个脚本 + 两个管理云函数完成。

#### 7.1 抽取雅思词表（ECDICT，MIT 许可）

词表来源 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT License, Copyright (c) 2025 Linwei，许可证副本见 `assets/word_lists/ECDICT-LICENSE.txt`）。

```bash
# 下载词库（约 63MB）
curl -L -o /tmp/ecdict.csv \
  https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

# 抽雅思词表：tag 含 ielts、排除中考/高考基础词、按 BNC 词频排序
python scripts/build_wordlist.py --src /tmp/ecdict.csv \
  --out assets/word_lists/ielts-5000.json --limit 5000
```

产出可直接作为 `seed_words` 的 `words` 入参。实测 ECDICT 中带 `ielts` 标签的共 5040 词，剔掉基础词与无音标 / 无释义的，得 **3056 词**。若想要含 `in / the` 这类最基础词的「完整版」，加 `--exclude-tags ""` 可得 4730 词。

> ⚠️ 别用 ECDICT 自带的 `audio` 字段——那是第三方词典的音频 URL，引用等于把版权风险搬回来。

#### 7.2 导入词表到数据库

云开发控制台 → 云函数 → `seed_words` → 云端测试，入参带管理密钥，即可导入内置示例词表（24 个雅思词）：

```json
{ "_token": "你在环境变量里设置的 ADMIN_TOKEN" }
```

> ⚠️ `seed_words` 会往数据库写词，且云函数**对全体小程序用户开放**，所以必须携带 `_token` 鉴权（见上面第 5 步的 `ADMIN_TOKEN`）。密钥不对会返回 `INVALID_ADMIN_TOKEN`；没配环境变量则返回 `ADMIN_TOKEN_NOT_CONFIGURED`。

**导入正式词表（几千词）必须分批**，否则单次调用会超时。入参格式：

```json
{ "_token": "你的密钥", "words": [ { "word": "abandon", "phoneticUK": "/əˈbændən/", "pos": "v.", "meaning": "放弃；抛弃" } ], "offset": 0, "limit": 200 }
```

- 每次改 `offset`（0 → 200 → 400 …）重复执行，直到返回里 `hasMore: false`；
- `seq` 会**自动接着库中最大值往后排**，不用手工传；
- 重复执行会按 `word` 去重，跳过已存在的词，可以放心重跑；
- 字段参考 `cloudfunctions/seed_words/words.json`，最少需要 `word / meaning`，建议带上 `phoneticUK / phoneticUS / pos`。

> ⚠️ **新导入的词默认 `audioReady: false`，不会进入学习流程**——必须先有发音音频，见 7.3。

#### 7.2.1 换词表 / 清空重来（`reset_words`）

**先说结论：`seed_words` 是「按 `word` 去重、命中即跳过」，永远不会覆盖已有词条。** 它只做：

```js
const exist = await words.where({ word: item.word }).get()
if (exist.data.length) { skipped++; continue }   // 一个字段都不改
```

所以想**替换**词库，必须先清空。直接删 `words` 集合会留下一堆孤儿数据，必须连派生数据一起处理：

| 集合 | 引用方式 | 处理 |
| --- | --- | --- |
| `words` | 本体（`_id` / `word` / `seq` / `audioReady`） | 清空 |
| `user_words` | `wordId` | 清空（否则复习池指向不存在的词） |
| `records` | `wordId` | 清空（否则错题本查不到词） |
| `daily_plans` | `newWordIds` / `reviewWordIds` / `practiceQueue[].wordId` | 清空（否则旧计划打不开） |
| `users` | `wordCursor`（按 seq 推进的出词游标） | **必须归零**，否则新词从 seq 1 开始却会被游标跳过 |
| `checkins` | 只有日期/次数 | 默认保留，`resetStats: true` 时一并清 |
| `audio_cache` | 按 `text` 建索引，不依赖 `_id` | **保留**，重导同名词可复用索引 |

**步骤一：预检（只读，不改数据）**

云开发控制台 → 云函数 `reset_words` → 云端测试：

```json
{ "_token": "你的密钥", "mode": "preview" }
```

返回 `before.collections` 各集合条数、`before.usersWithProgress`（已有学习进度的用户数），据此判断影响面。

> 📦 **执行前务必先备份**：控制台 → 数据库 → 选中集合 → 「导出」。本操作不可撤销。

**步骤二：执行清理**

```json
{ "_token": "你的密钥", "mode": "purge", "confirm": "PURGE" }
```

`confirm` 是防误触的二次确认口令，不传或传错都会拒绝执行。可选参数：

- `"collections": ["words", ...]` —— 自定义范围（白名单内），默认清四个
- `"resetCursor": false` —— 不重置 `users.wordCursor`
- `"resetStats": true` —— 连同 `streak` / `totalLearned` / `lastCheckinDate` 归零，并清 `checkins`

返回 `removed` 为各集合实际删除条数，`cursorReset` 为被重置游标的用户数。

**步骤三：重新导入 + 重新点亮**

```text
reset_words(purge)  →  seed_words(导入 pilot-100)  →  seed_audio(点亮 audioReady)
```

- 清空后 `seed_words` 的 `seq` 从 **1** 开始，与词表顺序完全一致（不再是续号）；
- `audio_cache` 被保留，重跑 `seed_audio` 时走的是 update 分支，返回体里 `updated` 有值而 `cached` 为 0，属正常。

> ⚠️ 云存储里的 `audio/` 目录**不要删**——同名音频文件重跑 `seed_audio` 会覆盖，无需重新上传。

#### 7.3 生成并发音上线（关键）

发音音频在本地用 **Kokoro-82M**（Apache-2.0，故生成的音频可自由商用）批量合成，再上传到云存储：

```bash
# 安装依赖（首次）
pip install -r scripts/requirements.txt
# 若 pip 报 EEXIST ... docopt_xxx（sdist 解包目录冲突），改用 uv：
#   uv pip install --python <venv>/bin/python --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
#     --index-strategy unsafe-best-match -r scripts/requirements.txt

# 境内必做两步（详见 scripts/requirements.txt 注释）：
export HF_ENDPOINT=https://hf-mirror.com   # Kokoro 权重走镜像
python scripts/install_spacy_model.py      # en_core_web_sm 不在 PyPI，需从 HF 镜像装

# 生成前 100 个词的美音（默认 --types us，只做美音）
python scripts/gen_audio.py --wordlist assets/word_lists/pilot-100.json --limit 100

# 之后增量补：从第 101 个词继续（已存在的文件自动跳过）
python scripts/gen_audio.py --wordlist assets/word_lists/ielts-5000.json --offset 100 --limit 100

# 需要英音时再显式指定（当前不做）
python scripts/gen_audio.py --wordlist ... --types uk

# 打包成 seed_audio 的入参（自动分批，每批 base64 ≤350KB）
python scripts/pack_audio.py

# 本地自测（不碰云端）：预检 + 生成试听页
python scripts/make_audition_page.py --wordlist assets/word_lists/pilot-100.json
```

> **只做美音（type=2）**：小程序端 `config.TTS_LANG = 'en_US'`，`langToType()` 映射出的就是 type 2，所以只生成美音即可覆盖全部播放场景。英音（type=1）留到将来做「英美音切换」功能时再补，`gen_audio.py --types uk` 一条命令即可增量生成。

#### 7.3.1 本地自测（上传前必做）

音频是**本地生成、云端只存**，所以质量问题和入参问题都应该在本地拦住：

```bash
python scripts/make_audition_page.py --wordlist assets/word_lists/pilot-100.json
```

它会做两件事：

1. **预检**（终端打印 + 页面顶部统计），逐词检查四类问题——
   - 词名是否满足云函数的 `TEXT_RE`（`^[A-Za-z][A-Za-z'’\- ]{0,39}$`），不满足则 `seed_audio` 会抛 `INVALID_WORD`
   - `slug` 是否撞车（`a-b` 与 `a_b` 会映射到同一个文件名而互相覆盖）
   - mp3 文件头是否合法、体积是否异常（<500B 疑似空音频 / >100KB 疑似多词拼接）
   - 词表里的词是否都有音频（缺音频的词会被云端跳过，`audioReady` 不会点亮）
2. **生成 `build/audition.html`**——双击即可在浏览器里试听，每条 ▶ 播放、勾「存疑」，最后一次性导出存疑词表，拿回去定向重生成。

> 也可直接命令行听单个词：`afplay build/audio/us/council.mp3`（macOS）。
>
> **同形异音词**要重点听：`assets/word_lists/pilot-100-homographs.json` 是从试听词表里自动挑出来的多音词（如 `contract` 名词「合同 /ˈkɒntrækt/」vs 动词「收缩 /kənˈtrækt/」），TTS 会只按一个读音念，需要人工确认或单独替换音频。

#### 7.3.2 上传到云端

把 `build/seed_audio/batch-*.json` 里的 `__ADMIN_TOKEN__` 换成真实密钥，依次在**云开发控制台 → 云函数 `seed_audio` → 云端测试**执行。每次调用完成三件事：

1. 把音频上传到云存储 `audio/{type}/{slug}.mp3`
2. 写入 `audio_cache` 集合（`text` + `type` + `fileID`）——运行时查这里即命中，**不再外呼任何第三方**
3. 把这批词在 `words` 里的 `audioReady` 置为 `true` —— **置位后才会进入每日学习队列**

> 控制台「云端测试」的入参框对超大 JSON 可能吃力。粘贴不进去时缩小批次：
> `python scripts/pack_audio.py --max-bytes 120000`（会切成更多、更小的批次）。

**验收**（云端三处都对上才算成功）：

| 位置 | 期望 |
| --- | --- |
| 云开发 → 存储 | `audio/2/` 下有 100 个 `.mp3` |
| 云开发 → 数据库 → `audio_cache` | 100 条记录，`source = preseed` |
| 云开发 → 数据库 → `words` | 这 100 个词的 `audioReady = true` |

控制台调 `seed_audio` 的返回体里 `uploaded / cached / marked` 三个数字应等于或接近本批条数，`failed` 为空。

于是「没有读音的词不会出现在学习中」自动成立，可以一批一批慢慢补，不必等全量生成完。学习队列由 `start_new_words` 按 `seq` 顺序取 `audioReady=true` 的词。

> ⚠️ 音频要按 `seq` **从前往后连续**生成。`finish_checkin` 的游标按 seq 取值推进（不是按词数累加），跳着生成虽不会出错，但学习顺序会出现空洞。

#### 7.4 例句音频（进阶，可选）

单词卡的「例句」旁有发音按钮，音频同样由**本地预生成**，不依赖任何第三方。

难点在于：例句文本原本是 `enrich_word` 在**用户首次学到该词时**（运行时）调 DeepSeek 生成的，本地在合成音频那一刻并不知道要念什么。所以要给例句配音频，必须先把例句**离线化**：

```text
① 离线生成例句      gen_examples.py       词表 + DeepSeek → assets/examples/*.json
② 本地合成例句音频  gen_sentence_audio.py Kokoro → build/sentence_audio/us/s_{hash}.mp3
③ 打包              pack_audio.py         转 base64 分批 → build/seed_sentence/batch-NN.json
④ 上传              seed_audio 云端测试   kind:"sentence" → 云存储 + audio_cache
```

```bash
# 密钥放项目根 .env（已在 .gitignore 中）或 export 到环境变量
export DEEPSEEK_API_KEY=sk-xxxx

# ① 生成例句（已生成的自动跳过；失败清单留在同目录，重跑即可补齐）
python scripts/gen_examples.py --wordlist assets/word_lists/pilot-100.json

# ② 合成音频
python scripts/gen_sentence_audio.py --examples assets/examples/pilot-100-examples.json

# ③ 本地自测：预检 + 生成例句试听页 build/audition_sentence.html
python scripts/make_audition_page.py --examples assets/examples/pilot-100-examples.json --open

# ④ 打包（注意 manifest / audiodir / outdir 三处都换成 sentence 的）
python scripts/pack_audio.py --manifest build/sentence_audio/manifest.json \
    --audiodir build/sentence_audio --outdir build/seed_sentence --max-bytes 600000

# ⑤ 填密钥（整个目录一次改完，不用逐个文件手工替换）
#    先在项目根 .env 里加一行 ADMIN_TOKEN=xxx（.env 已 gitignore），然后：
python scripts/fill_token.py --dir build/seed_sentence

# ⑥ 控制台 → 云函数 seed_audio → 云端测试，依次执行 batch-*.json
```

第 ③ 步的预检与单词侧同源，只是口径换成例句的：
`TEXT_RE_SENTENCE`（字母开头、≤200 字符）、`s_{hash}` 是否撞车、mp3 头与体积（<1.5KB 疑似空音频 / >100KB 疑似拼接）。

> **关于 `TEXT_RE_SENTENCE` 的写法**：它用的是**排除集**（允许除控制字符 / 反斜杠 / 反引号之外的可打印字符），而不是逐个列举标点。原因是真实例句里出现过 `%`（`The service sector accounts for over 70% of the country's GDP.`）——白名单每漏一个标点，对应例句的音频就查不到；而这条正则要在 `seed_audio` / `audio_cache` / `make_audition_page.py` **三处保持同步**，白名单极易漏改。

`gen_examples.py` 的 prompt 与云端 `enrich_word` **逐字对齐**，所以离线产出的例句质量和「云端现生成」一致；它还会顺带把 `roots` / `etymology` 一起存进 `assets/examples/*.json`（同一次请求本就会返回），将来若想彻底消除运行时的 AI 调用，可直接用这份 JSON 回填 `words` 集合。

**与单词音频的差异**（都已在代码里处理）：

| 方面 | 单词 | 例句 |
| --- | --- | --- |
| 入参字段 | `word` | `kind:"sentence"` + `text`（整句） |
| 文件名 | `slug(word)`，如 `council.mp3` | `s_{hash}`，如 `s_u40iyu.mp3` |
| `audioReady` | 命中即点亮，决定能否进入学习 | **不参与**（例句不影响出词） |
| dictvoice 兜底 | 有（词表外的词也能发音） | **无**——整句必失败，故只读不写 |
| 单批条数 | ≤80 | 17–22（单条约 21KB 音频，按每批 base64 ≤600KB 切） |
| 空音频判定 | <500B | <1.5KB |

**验收**：云存储 `audio/2/` 下出现 `s_*.mp3`；`audio_cache` 新增若干条 `kind = "sentence"` 的记录；`seed_audio` 返回体里 `sentences` 等于本批条数。

pilot-100 实测：100 条例句 → 音频 **2.06MB**（均值 **21.1KB/条**）→ 打包 **5 批**（2.74MB base64），预检 **100/100 通过**，hash 命名与云端逐条一致。

> ⚠️ **例句音频以整句文本为 key。** 若将来用 `force: true` 重新生成某个词的 AI 内容，例句文本会变、旧音频随即失效，需要重跑 ② ③ ④ 补齐。

> ⚠️ 云存储的 `audio/` 目录**不要删**：同名文件重跑 `seed_audio` 会直接覆盖，无需重新上传。

> 💡 例句音频约 20–40KB/条，是单词音频（约 6KB）的 5 倍左右。全量 3000 词约 90MB 存储、CDN 5GB/月约可支撑 17 万次播放。

### 8. 编译预览

回到开发者工具编译。首次进入会自动跳到「设置学习计划」，选 5 或 10 后即可开始。

---

## 核心机制说明

### AI 内容生成与缓存（降本关键）

单词的**例句 / 词根拆解 / 词源演变**缺失时，由 `word_card` → `enrich_word` 调用 **DeepSeek** 生成：

1. `words.enriched = true` → **直接读库，绝不调模型**
2. 未生成 → **乐观锁** `enrichStatus: pending → generating`，保证同一单词全局只生成一次
3. 生成 → **内容安全检测**（`msgSecCheck`）→ 写回并置 `enriched = true`
4. 失败 → 降级返回词表已有字段，标记 `failed`，由**定时任务**（每天 03:00）重试

`enrich_word/config.json` 已配置定时触发器（并把函数超时放宽到 30s，适配大模型响应耗时）；该函数的定时任务同时负责释放超时锁（>60s）。

### 每日闭环状态机

`daily_plans.stage`：`review → learning → practice → practice_done → done`

- **复习**：`user_words` 中 `status != mastered` 且 `nextReviewDate <= 今天` 的词，全部答对才解锁新词
- **打卡**：`practiceQueue` 全部答对后 `finish_checkin` 推进 `streak` 与 `wordCursor`

### 题型

- **中选项**（`cn_option`）：题干英文单词 → 选项 4 个中文释义
- **英选中**（`en_option`）：题干中文释义 → 选项 4 个英文单词
- 两种题型 1:1 交替混合；干扰项 3 个随机取自词库
- 判题在**服务端**（`submit_answer`），下发给客户端的题目不含答案

### 发音

**主音源是云存储里的离线音频**，不依赖任何第三方接口：

1. **预生成**：本地用 Kokoro-82M 批量合成（当前**先只做美音** type=2；英音留待后续），mp3 约 5KB/词，全量 5000 词约 25MB
2. **云存储 + `audio_cache` 集合**（跨用户共享）→ 前端请求时查库命中，直接返回 fileID，**全局零外呼**
3. **前端 wx.storage 缓存 fileID** → 命中秒播，连云函数都不调

首次播放某词：调 `audio_cache` 云函数 → 查库命中 → 返回云存储 fileID（约 0.5s）。若该词没有预生成音频，会降级到 dictvoice 兜底——但 `audioReady` 机制已保证学习流程里出现的词都有音频，所以这条兜底实际不会触发。

> 音频全部自持后可**删掉 `https://dict.youdao.com` 这个 downloadFile 合法域名**，提审少一项、也彻底摆脱第三方接口的版权灰区与限流风险——前提是词表全量都有预生成音频，否则会一并失去单词的兜底能力。

**例句发音**走同一套链路（`playSentence` → 以整句文本为 key 查 `audio_cache`），音频由本地预生成，流程见 **7.4 例句音频**。与单词不同，例句**没有 dictvoice 兜底**——整句本就无法用 dictvoice 合成，且放开会让任意长文本可写云存储；未预置音频时**静默不播**（补音频是渐进的，弹提示会持续打扰学习）。

> 更早的历史方案是微信同声传译插件（WechatSI），但该插件仅对企业主体开放，个人主体无法添加，已废弃。

---

## 待办 / 注意事项

- [x] **fork 后必须替换** `project.config.json` 的 `appid` 与 `miniprogram/config.js` 的 `ENV_ID` 为你自己的（二者非密钥，但用作者的会连到作者的云环境）
- [x] `enrich_word` 必须配置 `DEEPSEEK_API_KEY`（并确保账户有余额），否则单词卡只能显示词表基础字段
- [x] `enrich_word`、`seed_words`、`seed_audio`、`reset_words`、`init_db` **五个函数**都要配置 `ADMIN_TOKEN`（同一值），详见「5. 配置云函数环境变量」
- [x] 云开发控制台 → 设置 → **「未登录访问」保持关闭**（开启后任何持有环境 ID 的人都能访问你的云资源）
- [x] 数据表用 `init_db` 一键创建（幂等），索引与安全规则按「6. 初始化数据表」手工配置
- [x] 小程序发布前需完成 **ICP 备案**
- [x] 词表版权：已选定 **ECDICT（MIT License, Copyright (c) 2025 Linwei）**，经 `scripts/build_wordlist.py` 抽取，许可证副本随词表存放于 `assets/word_lists/`
- [ ] 音频版权：用 **Kokoro-82M（Apache-2.0）** 本地生成，音频可商用；不要换成系统 `say` / edge-tts 等受限或灰色音源
- [ ] 启用例句音频前，`seed_audio` 与 `audio_cache` **两个云函数都要重新上传部署**（新增例句分支 + 放宽 `TEXT_RE_SENTENCE`），否则带 `%` 等标点的例句会被判 `INVALID_SENTENCE`
- [ ] `scripts/fill_token.py` 填过密钥的 `batch-*.json` 含明文密钥，位于 `build/`（已 gitignore），**勿提交、勿外移**
- [ ] 正式环境建议给 `words` 集合配置自定义安全规则，只放开读权限

---

## 开源许可与声明

本项目以 **MIT License** 开源，详见 [LICENSE](./LICENSE)。

### 你可以做什么

自由使用、修改、分发、商用本代码，只需保留版权声明。fork 后按上面「待办」替换 `appid` / `ENV_ID` / 各环境变量即可跑起来。

### 需要你自行确认的部分

| 项         | 说明                                                                                   |
| --------- | ------------------------------------------------------------------------------------ |
| **品牌**    | 「雅词本」名称与 `assets/brand/` 下的头像/图标为作者品牌资产，MIT 许可**不含商标授权**。二次开发请更换名称与图标，避免与线上小程序混淆。（`assets/` 在 `miniprogramRoot` 之外，不会被打进小程序包） |
| **发音接口**  | 代码示例使用有道 `dictvoice` 接口，该接口并非有道对第三方开放的商用接口。商用请替换为合规 TTS 服务（见「发音」一节）。                 |
| **AI 内容** | 例句/词根/词源由 DeepSeek 生成，需遵循 DeepSeek 服务条款，API Key 请自行申请配置。                             |
| **词表**    | 雅思词表由 `scripts/build_wordlist.py` 从 **ECDICT（MIT License, Copyright (c) 2025 Linwei）** 抽取，可商用，需保留版权声明。内置 24 词为示例数据。 |
| **发音音频**  | 由 **Kokoro-82M（Apache-2.0）** 本地生成，音频可自由商用。改用其他引擎前请先确认该引擎对生成音频的授权——XTTS v2 / F5-TTS 的权重为非商用许可，`edge-tts` 属非官方客户端（与 dictvoice 同一灰色性质）。 |
| **合规**    | 上线需自行完成 ICP 备案、选择服务类目，并遵守《微信小程序平台运营规范》。                                              |

### 安全部署要点

- **云函数是对全体小程序用户开放的接口**：函数名藏不住、入参可伪造。管理/花钱/写库类能力务必自带校验——本项目已在 `enrich_word`（`force` 需管理员）、`seed_words` / `seed_audio` / `reset_words` / `init_db`（强制管理员密钥）、`audio_cache`（入参正则收敛）上都做了加固。
- **密钥只放云函数环境变量**：DeepSeek Key、`ADMIN_TOKEN` 都不得写进代码或 `miniprogram/` 下的任何文件（前端包体可被反编译）。
- **`AppSecret` 绝不入库**：云开发环境 ID 与小程序 AppID 属公开信息，`AppSecret` 才是能真正签发调用凭证的密钥。
