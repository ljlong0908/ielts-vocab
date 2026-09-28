# 部署与上线步骤（从零到可用）

> 本文是**唯一权威的部署清单**，按顺序执行即可跑通。`README.md` 是上手概览，细节以本文为准。
> 整条链路分两段：**云端（微信开发者工具操作）** 与 **本地（生成词表与音频）**，两者通过「控制台粘贴 JSON」衔接。

---

## 0. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 微信开发者工具 | 稳定版 | 需登录小程序账号 |
| 小程序 | 已注册，主体不限 | **个人主体可用**（不用同声传译插件，也不选教育类目） |
| 服务类目 | 工具 → 实用工具 | 个人主体可选；教育类目个人主体不可选 |
| Python | 3.10+ | 仅「本地生成词表/音频」阶段需要 |
| DeepSeek Key | `sk-...` | 仅 AI 内容生成需要（可后续再配） |

> 仓库地址与工作目录示例：`/Users/lijinlong/Projects/ielts-vocab`（下文记作 `<项目根>`）。

---

## 0.1 老环境升级到本版本（增量清单）

如果你已经部署过旧版本，按这张表做即可；**全新环境请直接从第 1 节开始**。

| 位置 | 必做 |
|---|---|
| **全部 15 个云函数** | 逐个重新「上传并部署：云端安装依赖」。`audio_cache` 与 `seed_audio` 有实质改动（例句分支 + 正则放宽），其余为依赖版本与超时声明统一 |
| **词表**（3056 → 3041 → 3036 → **2987** 词） | 云端若已导过旧词表，**必须**先 `reset_words`（`mode:'purge'` + `confirm:'PURGE'`）再重导。⚠️ 直接跑 `seed_words` 无效——它按 `word` 去重跳过，`wheels` / `jobs` 这类已删除的词会留在库里 |
| **云存储音频** | **无需重传**。`audio_cache` 与云存储 `audio/` 不参与 `reset_words`，同名文件重跑 `seed_audio` 会自动覆盖 |
| **小程序前端** | 重新编译上传（`app.js` / `config.js` / `utils/*` / `pages/learn/*` 均有改动；包体已从 970KB 降到约 176KB） |
| **环境变量** | 若曾轮换过 DeepSeek Key（旧 Key 暴露在历史代码中），需到 `enrich_word` → 配置 → 环境变量更新 `DEEPSEEK_API_KEY`；改动代码不会覆盖环境变量，**漏改则单词卡退化为只显示词表基础字段** |
| **数据表** | 已建过则不必重跑 `init_db`，跑一次 `mode:'preview'` 体检即可 |

> 换词表的完整流程见第 10 节。

---

## 1. 导入项目到开发者工具

1. 开发者工具 → **导入项目**
2. **目录选仓库根**（含 `project.config.json` 的那一层），**不要**选 `miniprogram/`
3. AppID 填你自己的：改 `project.config.json` 的 `appid`
4. 工具应能识别出 `miniprogramRoot: miniprogram/` 与 `cloudfunctionRoot: cloudfunctions/`

---

## 2. 开通云开发并填环境 ID

1. 工具栏 → **云开发** → 开通（选按量付费的免费额度即可，上线后需 19.9 元/月基础套餐）
2. 复制**环境 ID**（形如 `cloud1-xxxxxxxxxxxx`）
3. 填入 `miniprogram/config.js` 的 `ENV_ID`

> ⚠️ 云开发环境与 AppID 绑定。换 AppID 后必须**重新建环境**，旧环境调不通。

---

## 3. 配置云函数环境变量（关键，最容易漏）

⚠️ **环境变量是「函数级隔离」的**——同一个名字要在**每个用到它的函数上分别配一遍**，值保持一致。

| 云函数 | 需要的环境变量 | 作用 |
|---|---|---|
| `enrich_word` | `DEEPSEEK_API_KEY`、`ADMIN_TOKEN` | 调 DeepSeek；`force` 重生成需管理员 |
| `seed_words` | `ADMIN_TOKEN` | 导入词表 |
| `seed_audio` | `ADMIN_TOKEN` | 上传音频 |
| `reset_words` | `ADMIN_TOKEN` | 清空词库（破坏性） |
| **`init_db`** | `ADMIN_TOKEN` | **初始化数据表（新增）** |

生成一个密钥（24 字节十六进制，够用）：

```bash
openssl rand -hex 24
```

配置路径：云开发控制台 → 云函数 → 选中函数 → **版本与配置** → 环境变量 → 保存 → **按提示重新部署**。

> `ADMIN_TOKEN` 五个函数**同一个值**；`DEEPSEEK_API_KEY` 只配在 `enrich_word`。

### 3.1 自查是否配好了（不用翻控制台）

在控制台「云端测试」里故意传一个**错的** token，看返回文案：

| 返回 | 含义 |
|---|---|
| `ADMIN_TOKEN_NOT_CONFIGURED` | 该函数**没配**环境变量 |
| `INVALID_ADMIN_TOKEN` | 已配，只是 token 传错了 → ✅ 配置正确 |
| 正常业务返回 | 配置正确且 token 也对 |

`init_db` 入参：`{"_token":"wrong"}`。逐个函数打一遍即可确认。

---

## 4. 部署云函数（共 15 个）

对 `cloudfunctions/` 下**每一个**目录：右键 → **上传并部署：云端安装依赖**（不要选「上传所有文件」，否则依赖不装）。

| # | 云函数 | 作用 | 调用方 | 超时 |
|---|---|---|---|---|
| 1 | `user_profile` | 登录 + 每日目标 | 前端 | 20s |
| 2 | `home_summary` | 首页聚合 | 前端 | 20s |
| 3 | `today_flow` | 当日流程状态机（前端唯一状态来源） | 前端 | 20s |
| 4 | `start_new_words` | 幂等生成当日新词队列 | 前端 | 20s |
| 5 | `word_card` | 单词卡（触发 AI 补全） | 前端 | 30s |
| 6 | `build_questions` | 生成题目（答案留服务端） | 前端 | 30s |
| 7 | `submit_answer` | 服务端判题 + 推进复习 | 前端 | 20s |
| 8 | `finish_checkin` | 打卡（幂等） | 前端 | 30s |
| 9 | `stats` | 统计 + 错题 | 前端 | 30s |
| 10 | `audio_cache` | 音频读缓存 | 前端 | 20s |
| 11 | `enrich_word` | AI 内容补全（含定时触发器） | `word_card` 服务端调用 + 定时 | 30s |
| 12 | `seed_words` | 词表导入 | 控制台 | 60s |
| 13 | `seed_audio` | 音频入库 + 点亮 `audioReady` | 控制台 | 60s |
| 14 | `reset_words` | 词库重置（破坏性） | 控制台 | 60s |
| 15 | `init_db` | **数据表初始化（幂等）** | 控制台 | 60s |

**部署后核对两件事**（控制台 → 云函数 → 配置）：

- 超时时间与上表一致（`config.json` 会自动带上，若控制台显示不一致以控制台为准改一下）
- `enrich_word` 的**定时触发器**已创建（`enrichRetryTimer`，每天 03:00，用于释放超时锁 + 重试失败的 AI 补全）

> ⚠️ 云函数**名字不能以下划线开头**（腾讯云 SCF 规范）。

---

## 5. 初始化数据表（`init_db`）

### 5.1 体检

控制台 → 云函数 `init_db` → 云端测试 → 入参：

```json
{ "_token": "你的 ADMIN_TOKEN", "mode": "preview" }
```

返回 `data.collections` 会逐个列出集合的 `exists` 与当前文档数，`data.missing` 是缺的集合。

### 5.2 建表

```json
{ "_token": "你的 ADMIN_TOKEN", "mode": "create" }
```

- 返回 `data.created` = 本次新建的集合，`data.missing` 应为空、`data.ready` 为 `true`
- 幂等：已存在的自动跳过，重复执行不会报错

### 5.3 手工建索引（SDK 做不到，必须控制台操作）

控制台 → 数据库 → 选中集合 → 索引管理 → 添加。返回体的 `data.indexes` 就是这份清单：

| 集合 | 索引字段 | 唯一 | 用途 |
|---|---|---|---|
| `users` | `_openid`（升序） | ✅ | 登录查用户 |
| `words` | `word`（升序） | ✅ | 导入去重 / 音频点亮按词名匹配 |
| **`words`** | **`audioReady` + `seq`** | ❌ | **★ 出词性能关键**：`audioReady=true` 且 `seq` 递增 |
| `user_words` | `_openid` + `wordId` | ✅ | 学习状态读写 |
| `user_words` | `_openid` + `status` + `nextReviewDate` | ❌ | 复习池查询 |
| `daily_plans` | `_openid` + `date` | ✅ | 当日计划唯一 |
| `records` | `_openid` + `date` | ❌ | 答题记录按日查 |
| `records` | `_openid` + `isCorrect` | ❌ | 错题本 |
| `checkins` | `_openid` + `date` | ✅ | 打卡幂等 |
| `audio_cache` | `text` + `type` | ✅ | 音频索引唯一 |

> 「唯一」索引同时是**幂等保障**：`checkins`、`daily_plans`、`audio_cache` 靠它杜绝重复写入。

### 5.4 安全规则（控制台 → 数据库 → 集合 → 权限设置）

| 集合 | 权限 |
|---|---|
| `words` | **所有用户可读，仅管理端可写** |
| 其余全部 | **仅创建者可读写** |

> ⚠️ 以下三项是「对外开放面」，**必须保持关闭/收紧**：
> 1. 云开发 → 设置 → **「未登录用户访问云资源」** = 关闭
> 2. 云函数 **HTTP 访问服务 / HTTP 触发路径** = 不使用
> 3. 任何集合都**不能**设成「所有人可写」

---

## 6. 导入词表（`seed_words`）

词表已是仓库资产：`assets/word_lists/ielts-full.json`（**2987 词**，已做名词复数归一 + 专名剔除）。

也可自己重新抽词（需要 ECDICT 的 `ecdict.csv`，约 63MB）：

```bash
cd <项目根>
python scripts/build_wordlist.py --src /tmp/ecdict.csv \
  --out assets/word_lists/ielts-full.json
```

> 脚本会输出完整筛选漏斗（扫描行数 → 排除基础词 → 剔除专名 → 复数归一 → 实收词数）。
> 三条清洗规则都以常量形式放在脚本里，**重跑即复现**，不需要手工改词表：
> 1. `--exclude-tags zk,gk` —— 中考/高考基础词不入表
> 2. `PROPER_NOUNS` —— 地名/机构/姓氏剔除（`york` / `sydney` / `forbes` / `tours` / `wollongong`），判据为「中文释义括号里的地名·姓氏标记」或「英文释义里的地名·王室指式」，实测 0 误报
> 3. **名词复数归一** —— 纯复数条目一律不作为词条：原形已在表内或是基础词的丢弃（`wheels` / `jobs` / `universities`），原形查得到的提升为原形（`utensils` → `utensil`）；`KEEP_PLURAL` 保留语义已分化的独立词条（`economics` / `odds` / `pants` / `bacteria` …）

导入分三步：

**① 打包入参**（本地，一次生成全部批次）

```bash
python scripts/pack_words.py                     # 默认 200 词/批 → 15 批，每批约 38KB
python scripts/pack_words.py --batch-size 100    # 控制台入参框卡顿时改小
python scripts/pack_words.py --wordlist assets/word_lists/pilot-100.json   # 100 词试点
```

**② 填密钥**

```bash
# 先在项目根 .env 写一行 ADMIN_TOKEN=xxx（.env 已 gitignore）
python scripts/fill_token.py --dir build/seed_words
```

**③ 依次执行**

控制台 → 云函数 `seed_words` → 云端测试，把 `build/seed_words/batch-01.json` …
`batch-16.json` 的**整段内容**粘进入参框，每批执行一次。

返回 `{ inserted, skipped, total, offset, limit, nextOffset, hasMore, lastSeq }`。

> 也可以不用打包脚本，手动传全量数组 + `offset` / `limit` 切片
> （`{"_token":"...","words":[...],"offset":0,"limit":200}`）——但那样每次都要粘整份词表，不推荐。

**关键语义**：

- 按 `word` 去重，命中即**跳过**（`skipped++`），**永不覆盖**已存在词条
- **忽略词表自带的 `seq`**，取库中最大 `seq` 续号 → 想从 1 开始必须先在空库导入
- 新导入的词一律 `audioReady: false` → **不会进入学习流程**，等 `seed_audio` 点亮

> 换成小规模试点：用 `assets/word_lists/pilot-100.json`（100 词）。

---

## 7. 生成并上传发音（本地）

### 7.1 环境准备（一次性）

```bash
cd <项目根>
python -m venv .venv && source .venv/bin/activate

# 境内建议：pip 装 kokoro 可能报 EEXIST ... docopt_xxx（sdist 解包冲突），改用 uv 更稳
pip install uv
uv pip install --python .venv/bin/python \
  --index-url https://pypi.tuna.tsinghua.edu.cn/simple \
  --index-strategy unsafe-best-match -r scripts/requirements.txt

# en_core_web_sm 不在 PyPI，misaki 会去 GitHub 拉（境内必挂）→ 用这个脚本从 HF 镜像装
export HF_ENDPOINT=https://hf-mirror.com
python scripts/install_spacy_model.py
```

### 7.2 单词音频（四步）

```bash
export HF_ENDPOINT=https://hf-mirror.com

# ① 合成（默认只做美音；已存在的自动跳过，可增量续跑）
python scripts/gen_audio.py --wordlist assets/word_lists/pilot-100.json --limit 100

# ② 预检 + 生成试听页（上传前必做）
python scripts/make_audition_page.py --wordlist assets/word_lists/pilot-100.json

# ③ 打包成 seed_audio 入参（自动分批，每批 base64 ≤350KB）
python scripts/pack_audio.py

# ④ 把 batch-*.json 里的 __ADMIN_TOKEN__ 换成真实密钥
#    （先在项目根 .env 写一行 ADMIN_TOKEN=xxx，.env 已 gitignore）
python scripts/fill_token.py --dir build/seed_audio
```

在试听页（`build/audition.html`，双击即可）里逐条确认读音，读错的删掉 mp3 重生成。

### 7.3 上传到云端

控制台 → `seed_audio` → 云端测试，**依次**执行 `build/seed_audio/batch-01.json`、`batch-02.json`…（文件内容整段粘进入参框）。

一次调用完成三件事（幂等，失败直接重跑）：

1. `uploadFile` → 云存储 `audio/{type}/{slug}.mp3`
2. upsert `audio_cache`（`text` + `type` → `fileID`，`source: 'preseed'`）
3. **仅单词**：把 `words` 里同名词的 `audioReady` 置 `true` → 从此进入学习队列

> 控制台入参框吃不消大 JSON 时缩批：`python scripts/pack_audio.py --max-bytes 120000`。

### 7.4 例句音频（可选，进阶）

例句文本原本由 `enrich_word` 在运行时生成，要配本地语音必须先把文本离线化：

```bash
# ① 离线生成例句（DeepSeek，prompt 与云端逐字对齐；顺带落盘 roots/etymology）
python scripts/gen_examples.py --wordlist assets/word_lists/pilot-100.json

# ② 合成整句音频
python scripts/gen_sentence_audio.py --examples assets/examples/pilot-100-examples.json

# ③ 预检 + 试听页
python scripts/make_audition_page.py --examples assets/examples/pilot-100-examples.json

# ④ 打包（注意 manifest / audiodir / outdir 三处都换成 sentence 的）
python scripts/pack_audio.py --manifest build/sentence_audio/manifest.json \
    --audiodir build/sentence_audio --outdir build/seed_sentence --max-bytes 600000

# ⑤ 填密钥
python scripts/fill_token.py --dir build/seed_sentence

# ⑥ 控制台 → seed_audio → 依次执行 build/seed_sentence/batch-*.json
```

> 例句音频**不点亮 `audioReady`**（不参与出词）；`audio_cache` 对例句**只查库不兜底**。
> ⚠️ 用 `force: true` 重新生成 AI 内容会让例句文本变化、旧音频失效，需重跑 ②~⑥。

---

## 8. 编译预览与验收

工具里点「编译」→ 模拟器应从 `pages/index` 起步（未设过目标会自动跳 `onboarding`）。

### 验收清单

- [ ] 首次进入 → 引导页选每日目标 5/10 → 回首页
- [ ] 首页显示「连续打卡 / 累计学习 / 今日进度」
- [ ] 「开始今日学习」能出词，**每个词都有发音**（点喇叭能响）
- [ ] 学完 → 练习（中选项 / 英选中混排）→ 答错可重选，答对自动下一题
- [ ] 练习全对 → 打卡页显示连续天数与累计
- [ ] 次日再进：先出现「复习昨天」阶段
- [ ] 统计页日历有打卡标记；错题本能查到答错的词

### 云端三处对账（`seed_audio` 是否成功）

| 位置 | 期望 |
|---|---|
| 云开发 → 存储 | `audio/2/` 下有对应 mp3（例句为 `s_*.mp3`） |
| 云开发 → 数据库 → `audio_cache` | 条数与上传数一致，`source = preseed` |
| 云开发 → 数据库 → `words` | 上传的词 `audioReady = true` |

云函数返回体 `uploaded / cached / marked` 应≈本批条数，`failed` 为空。

---

## 9. 常见报错排查

| 报错 | 原因 | 处理 |
|---|---|---|
| `FUNCTION_NOT_FOUND` | 云函数没部署 | 逐个「上传并部署：云端安装依赖」 |
| `FunctionName取值与规范不符` | 函数名以下划线开头 | 改成字母开头 |
| `Db not exist` / `collection not exists` | 集合没建 | 跑 `init_db`（见第 5 节） |
| `ADMIN_TOKEN_NOT_CONFIGURED` | 该函数没配环境变量 | 见第 3 节，注意**函数级隔离** |
| `INVALID_ADMIN_TOKEN` | 入参 `_token` 不对 | 与 `env.ADMIN_TOKEN` 对齐 |
| `INVALID_WORD` | 词名不过 `TEXT_RE` | 字母开头、≤40 字符、仅字母/撇号/连字符/空格 |
| `INVALID_SENTENCE` | 例句不过 `TEXT_RE_SENTENCE` | 见 `seed_audio/index.js` 的排除集正则 |
| `NOT_PRESEEDED` | 例句音频未预置 | 正常现象；跑第 7.4 节补音频 |
| `Cannot create field 'x' in element {y:null}` | 对 `null` 字段做点操作 | 已用 `_.set()` 规避；新代码照抄 `enrich_word` |
| 云函数返回 500 + 网络异常 | 见上，或超时太短 | 核对第 4 节超时表 |
| 发音不响且无报错 | 音频未点亮 / 域名未配 | 查 `audioReady`；若仍走 dictvoice 需配 `downloadFile` 合法域名 `https://dict.youdao.com` |
| 页面空白、数据读不到 | 云开发开了「未登录访问」被关，或权限设错 | 查第 5.4 节安全规则 |

---

## 10. 换词表 / 推倒重来

```json
// ① 预检（只读）：看各集合条数、有学习进度的用户数
{ "_token": "xxx", "mode": "preview" }
```

**② 先备份**：控制台 → 数据库 → 集合 → 导出。

```json
// ③ 清空（破坏性，必须带 confirm）
{ "_token": "xxx", "mode": "purge", "confirm": "PURGE" }
```

清理范围：`words` + `user_words` + `records` + `daily_plans`，并把 `users.wordCursor` **归零**。
**保留**：`audio_cache`（按 `text` 建索引，重导可复用）、`checkins`、云存储 `audio/` 目录。

然后重新走第 6 → 7 节（导入新词表 → 上传音频）。

> ⚠️ 「只删 `words` 再重导」是错的：`user_words.wordId`、`records.wordId`、`daily_plans.newWordIds/reviewWordIds/practiceQueue[].wordId` 都引用 `words._id`，只删词会留一地孤儿数据，`wordCursor` 也会错位。

---

## 11. 提审前检查

- [ ] `.env`、`project.private.config.json` 未入库（`.gitignore` 已覆盖）
- [ ] 前端包体内**搜不到 `sk-`**（密钥只在云函数环境变量）
- [ ] 云开发「未登录访问」关闭、无 HTTP 触发路径、无「所有人可写」集合
- [ ] 词库与音频许可：ECDICT（MIT）+ Kokoro-82M（Apache-2.0），保留 `assets/word_lists/ECDICT-LICENSE.txt`
- [ ] 隐私保护指引与代码一致（不收集昵称/头像/微信运动，见 `docs/隐私保护指引.md`）
- [ ] 音频全部自持后，移除 `downloadFile` 合法域名 `https://dict.youdao.com`
- [ ] 服务类目：工具 → 实用工具
