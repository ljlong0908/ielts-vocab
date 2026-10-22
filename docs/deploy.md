# 部署与上线步骤（从零到可用）

> 本文是**唯一权威的部署清单**，按顺序执行即可跑通。`README.md` 是上手概览，细节以本文为准。
> 整条链路分两段：**云端（微信开发者工具里部署 18 个云函数）** 与 **本地（生成词表与音频、初始化数据）**。
> 数据初始化已完全本地化（`init_cloud.py` / `seed_cloud.py` 走云开发 HTTP API），
> 只剩**集合权限**要手工点一次。

---

## 0. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 微信开发者工具 | 稳定版 | 需登录小程序账号 |
| 小程序 | 已注册，主体不限 | **个人主体可用**（不用同声传译插件，也不选教育类目） |
| 服务类目 | 工具 → 实用工具 | 个人主体可选；教育类目个人主体不可选 |
| Python | 3.10+ | 仅「本地生成词表/音频」阶段需要 |
| DeepSeek Key | `sk-...` | 仅 AI 内容生成需要（可后续再配） |
| **费用** | **认证 ¥30/年 + 云开发 ¥19.9/月** | 个人主体认证 ¥30/年（企业主体为 ¥300/年）；云开发基础套餐 ¥19.9/月（原价 ¥39）。除此之外**无服务器、无域名、无运行时 API 费用**。合计约 **¥270/年** |

> ⚠️ **免费环境的有效期**：云开发给新用户一个与基础套餐同配额的**免费环境**，但仅限**小程序未发布上线**阶段；
> 一旦发布，环境到期时间即为**上线后第 15 天**，之后必须转付费基础套餐。别按免费额度做长期规划。

> 仓库地址与工作目录示例：`/Users/lijinlong/Projects/ielts-vocab`（下文记作 `<项目根>`）。

---

## 0.1 老环境升级到本版本（增量清单）

如果你已经部署过旧版本，按这张表做即可；**全新环境请直接从第 1 节开始**。

| 位置 | 必做 |
|---|---|
| **全部 18 个云函数** | **一条命令搞定**：`python3 scripts/deploy_functions.py --all`（需先开「服务端口」，见 4.1）。或按界面逐个「上传并部署：云端安装依赖」。`audio_cache` 与 `seed_audio` 有实质改动（例句分支 + 正则放宽），其余为依赖版本与超时声明统一；**加练（`start_extra_round` / `finish_extra_round`）与错题本「已掌握」（`dismiss_wrong`）为新增函数，旧环境必须补部署**。⚠️ `finish_extra_round` 后来又加了「加练计入累计学习」，**若你已部署过加练版本，需再传一次**（漏传的表现：加练完成后首页「累计学习」数字不涨）。⚠️ `dismiss_wrong` 依赖 `stats` 同步更新（错题查询加了 `mastered` 过滤），**两个必须一起部署**，只部署一个会导致「点了已掌握、列表里还在」或反之 |
| **词表 + 数据** | 旧词表按**字母序**、新词表按**词频序**，两套 `seq` 语义不同，必须清空重导：`python scripts/seed_cloud.py --apply --reset`（脚本会先自动备份到 `build/backup/`）。⚠️ 不带 `--reset` 跑只会把新词**追加**在旧词后面，出词顺序全乱 |
| **云存储音频** | **无需重传**。`audio_cache` 与云存储 `audio/` 不参与重置，重跑 `seed_cloud.py` 会按 `(text, type)` 自动跳过已缓存的音频。⚠️ **但老环境缺「每日一句」的 12 句音频**（`audio_cache` 只有 200 条 = 100 单词 + 100 例句），需按 **7.5 节**补跑一次，否则首页喇叭点了没声音、也无提示 |
| **小程序前端** | 重新编译上传（`app.js` / `config.js` / `utils/*` / `pages/learn/*` 均有改动；包体已从 970KB 降到约 164KB） |
| **环境变量** | 若曾轮换过 DeepSeek Key（旧 Key 暴露在历史代码中），需到 `enrich_word` → 配置 → 环境变量更新 `DEEPSEEK_API_KEY`；改动代码不会覆盖环境变量，**漏改则单词卡退化为只显示词表基础字段** |
| **数据表** | 已建过则不必重跑。用 `python scripts/init_cloud.py`（只读体检）核对集合与索引是否齐全，缺了再 `--apply` |

> 换词表的完整流程见第 10 节。

---

## 1. 导入项目到开发者工具

1. 开发者工具 → **导入项目**
2. **目录选仓库根**（含 `project.config.json` 的那一层），**不要**选 `miniprogram/`
3. AppID 填你自己的：改 `project.config.json` 的 `appid`
4. 工具应能识别出 `miniprogramRoot: miniprogram/` 与 `cloudfunctionRoot: cloudfunctions/`

---

## 2. 开通云开发并填环境 ID

1. 工具栏 → **云开发** → 开通（选按量付费的免费额度即可；⚠️ 免费环境只到**小程序上线后第 15 天**，长期运行需转 **19.9 元/月**基础套餐 —— 见第 0 节「费用」）
2. 复制**环境 ID**（形如 `cloud1-xxxxxxxxxxxx`）
3. 填入 `miniprogram/config.js` 的 `ENV_ID`

> ⚠️ 云开发环境与 AppID 绑定。换 AppID 后必须**重新建环境**，旧环境调不通。

---

## 3. 配置云函数环境变量（关键，最容易漏）

⚠️ **环境变量是「函数级隔离」的**——同一个名字要在**每个用到它的函数上分别配一遍**，值保持一致。

> 💡 走本仓库推荐的**本地脚本路径**（`init_cloud.py` / `seed_cloud.py`）时，管理类函数
> （`seed_words` / `seed_audio` / `reset_words` / `init_db`）**不需要**配 `ADMIN_TOKEN`——
> 脚本直接用云开发 HTTP API 读写，绕开了云函数。只有 `enrich_word` 建议配上
> （强制富化 `force: true` 要用），以及你打算走控制台路径时。

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

> **本地也能自查（不用翻控制台）**：`.env` 里已写 `ADMIN_TOKEN` 时，用 HTTP API 调 `init_db` 即可 ——
> `POST /tcb/invokecloudfunction?access_token=<token>&name=init_db`，
> body 传 `{"env":"<ENV_ID>","_token":"<本地同一个值>","mode":"preview"}`。
> 返回 `{"code":0,"data":{"ready":true,"collections":{...}}}` = **云端 token 与本地一致 + 7 个集合齐备**，一次验两件事。
> 反之若回 `INVALID_ADMIN_TOKEN`，说明两边值不一样。
>
> ⚠️ **入参格式（踩过坑，别照抄网上的 `data` 写法）**：事件字段要**平铺在 body 顶层**。
> 写成 `{"env":…,"data":{…}}`（无论 `data` 传对象还是 JSON 字符串）函数都收不到字段 ——
> 表现是函数内 `event.text` 之类的取值为空，返回它自己的「缺参数」错误（如音频函数回
> `{"code":-1,"message":"missing text"}`），而外层 `errcode` 仍是 **0**，极易误判成「函数有 bug」。
> 另外**用不需要入参的函数（`stats` / `today_flow`）试格式会得到假阳性**：它们随便什么 body 都正常返回。

---

## 4. 部署云函数（共 18 个）

### 4.1 推荐：一条命令（`scripts/deploy_functions.py`）

```bash
python3 scripts/deploy_functions.py              # 只部署「改动过的」（默认）
python3 scripts/deploy_functions.py --all        # 全部 18 个
python3 scripts/deploy_functions.py --names stats dismiss_wrong
python3 scripts/deploy_functions.py --dry-run    # 先看要传哪些，不动云端
```

脚本内部走开发者工具自带的 CLI，`--remote-npm-install` 等价于界面上的「云端安装依赖」。
「改动过」＝ 三者的并集（宁多勿漏）：① `git status` 里的未提交改动与未跟踪新目录
② 文件 mtime 比 `build/.deploy-state.json` 记录的上次部署时间新 ③ state 里没记录过的
（基线不存在时不启用 ②，避免首次运行退化成「全部」）。
部署成功后写入 state，供下次做增量。

> ⚠️ **前置：开发者工具 → 设置 → 安全设置 → 打开「服务端口」**，且 IDE 保持运行。
> CLI 靠它与 IDE 通信，**不打开会静默卡死**（实测 3 分钟无任何输出，最终被系统杀掉），
> 既不报错也不提示，极易误判成「CLI 不能用」。脚本对此有超时兜底并会直接告诉你这一步。

> 💡 **为什么该用 `-r`（云端安装依赖）而不是连 `node_modules` 一起传**：
> 本项目 `enrich_word` / `seed_words` / `start_extra_round` / `finish_extra_round`
> 四个目录各带了约 80MB 本地 `node_modules`（`cloudfunctions/` 合计 322MB），
> 那是早期为绕开 `-504002` 手工拷进去的。加了 `-r` 后这四个只传几十 KB，
> 依赖由云端按 `package.json` 安装 —— 前提是每个函数的三件套齐全（`check_miniprogram.js` 会查）。
> 需要连本地依赖一起传时（云端装不上依赖的兜底）加 `--local-deps`。

### 4.2 等价备选：界面逐个点

对 `cloudfunctions/` 下**每一个**目录：右键 → **上传并部署：云端安装依赖**（不要选「上传所有文件」，否则依赖不装）。

> ⚠️ **每个云函数目录必须齐三件**：`index.js` + `config.json` + `package.json`。
> 漏 `package.json` 时「云端安装依赖」无从可装，函数能上传成功但**一调用就报**
> `Cannot find module 'wx-server-sdk'`（`errcode: -504002`）——看起来像代码 bug，其实是缺依赖声明。
> `package.json` 里必须含 `"dependencies": { "wx-server-sdk": "~2.6.3" }`，与其余 16 个函数保持一致。
> 一键核对：`node scripts/check_miniprogram.js`（第 ⑤ 项会逐个列出缺件）。

### 4.3 直接用 CLI（不用脚本）

`CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli`，手动指定函数名：

```bash
"$CLI" cloud functions deploy --project /Users/lijinlong/Projects/ielts-vocab \
  --env cloud1-d3g7gz4uo668f8faa --remote-npm-install \
  --names user_profile home_summary today_flow start_new_words word_card \
          build_questions submit_answer finish_checkin stats audio_cache \
          start_extra_round finish_extra_round dismiss_wrong \
          enrich_word seed_words seed_audio reset_words init_db
```

> `--names` 是 array 类型，要放**最后**，否则会吞掉紧随其后的参数。
> 核对结果：`"$CLI" cloud functions list --env <ENV_ID>`（`--env` 是**必填**，漏了只会打印帮助不报错）。

> 云函数**没有 HTTP API**（试 `/tcb/getfunctionlist` 报 `40066 invalid url`），所以列表与部署只能走 IDE 界面或这个 CLI。
> 「批量部署」可以脚本化（上面 4.1），但**首次开启服务端口**这一步只能在图形界面里点。


| # | 云函数 | 作用 | 调用方 | 超时 |
|---|---|---|---|---|
| 1 | `user_profile` | 登录 + 每日目标 | 前端 | 20s |
| 2 | `home_summary` | 首页聚合 | 前端 | 20s |
| 3 | `today_flow` | 当日流程状态机（前端唯一状态来源） | 前端 | 20s |
| 4 | `start_new_words` | 幂等生成当日新词队列 | 前端 | 20s |
| 5 | `word_card` | 单词卡（触发 AI 补全） | 前端 | 30s |
| 6 | `build_questions` | 生成题目（答案随题下发，供前端本地判题） | 前端 | 30s |
| 7 | `submit_answer` | 后台落库 + 推进复习 | 前端 | 20s |
| 8 | `finish_checkin` | 打卡（幂等） | 前端 | 30s |
| 9 | `stats` | 统计 + 错题 | 前端 | 30s |
| 10 | `audio_cache` | 音频读缓存 | 前端 | 20s |
| 11 | `start_extra_round` | 发起加练「再学一组」（幂等，需当日已打卡） | 前端 | 30s |
| 12 | `finish_extra_round` | 结算加练组（推进游标 + 计入累计学习；不动 streak / checkins / stage） | 前端 | 30s |
| 13 | `enrich_word` | AI 内容补全（含定时触发器） | `word_card` 服务端调用 + 定时 | 30s |
| 14 | `seed_words` | 词表导入 | 本地脚本（备选：控制台） | 60s |
| 15 | `seed_audio` | 音频入库 + 点亮 `audioReady` | 本地脚本（备选：控制台） | 60s |
| 16 | `reset_words` | 词库重置（破坏性） | 本地脚本（备选：控制台） | 60s |
| 17 | `init_db` | 数据表初始化（建集合） | 本地脚本（备选：控制台） | 60s |
| 18 | `dismiss_wrong` | 错题本「已掌握」：给 `records` 打 `mastered` 标 | 前端 | 10s |

**部署后核对两件事**（控制台 → 云函数 → 配置）：

- 超时时间与上表一致（`config.json` 会自动带上，若控制台显示不一致以控制台为准改一下）
- `enrich_word` 的**定时触发器**已创建（`enrichRetryTimer`，每天 03:00，用于释放超时锁 + 重试失败的 AI 补全）

> ⚠️ 云函数**名字不能以下划线开头**（腾讯云 SCF 规范）。

---

## 5. 初始化数据表

两条路选一条，结果完全等价。**5.1 本地一键**更省事（不用点控制台 17 次）；5.2 是原来的控制台流程。

### 5.1 本地一键（推荐）

微信云开发的 HTTP API 提供了建集合与**建索引**的接口（`/tcb/updateindex` 是控制台之外唯一的建索引途径），所以能整段在本地做完。

先在项目根 `.env` 补一行（`.env` 已 gitignore）：

```
WX_APP_SECRET=<小程序后台「开发管理 → 开发设置」里的 AppSecret>
```

> AppID 自动读 `project.config.json`，环境 ID 自动读 `miniprogram/config.js`——都不用填。
> ⚠️ AppSecret 是小程序**最高权限凭证**，只放本地 `.env`：不要写进小程序代码，也不要配到云函数环境变量里。

```bash
python scripts/init_cloud.py            # ① 体检（只读，不动云端）
python scripts/init_cloud.py --apply    # ② 执行：建缺失集合 + 补缺失索引（幂等）
```

脚本做四件事：

1. 打印自动发现的 AppID / 环境 ID，以及期望的 7 个集合、10 条索引
2. **清单漂移告警**——比对 `assets/db-indexes.json` 与 `cloudfunctions/init_db/index.js` 的索引数，有一边改漏了就提示
3. 建缺失集合（已存在的跳过；建完复查）
4. 建缺失索引（幂等：同名索引重复创建**不会**重复添加；建完按「索引数 / 应有数」复查，应有数 = `_id_` + 云开发自动建的 `_openid_1` + 清单条数）

集合与索引的权威清单在 **`assets/db-indexes.json`**，改索引请改这里。

> 💡 幂等：集合已存在跳过、索引已存在跳过，反复跑没有副作用。
> ⚠️ 但**唯一索引**建在有重复数据的集合上会失败——全新环境是空集合，不会遇到；若是老环境加索引，先清掉重复数据。
> ⚠️ **安全规则仍只能手工**（HTTP API 没有对应接口）→ 见 5.3。

### 5.2 控制台路径（等价备选）

#### 5.2.1 体检

控制台 → 云函数 `init_db` → 云端测试 → 入参：

```json
{ "_token": "你的 ADMIN_TOKEN", "mode": "preview" }
```

返回 `data.collections` 会逐个列出集合的 `exists` 与当前文档数，`data.missing` 是缺的集合。

#### 5.2.2 建表

```json
{ "_token": "你的 ADMIN_TOKEN", "mode": "create" }
```

- 返回 `data.created` = 本次新建的集合，`data.missing` 应为空、`data.ready` 为 `true`
- 幂等：已存在的自动跳过，重复执行不会报错

#### 5.2.3 手工建索引（仅当 5.1 没走通时才需要）

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

### 5.3 安全规则（控制台 → 数据库 → 集合 → 权限设置）

| 集合 | 权限 |
|---|---|
| `words` | **所有用户可读，仅管理端可写** |
| 其余全部 | **仅创建者可读写** |

> ⚠️ 以下三项是「对外开放面」，**必须保持关闭/收紧**：
> 1. 云开发 → 设置 → **「未登录用户访问云资源」** = 关闭
> 2. 云函数 **HTTP 访问服务 / HTTP 触发路径** = 不使用
> 3. 任何集合都**不能**设成「所有人可写」

---

## 6. 导入数据（词表 + 例句 + 音频，本地一键）

**数据全部由一条本地命令导入**——走云开发 HTTP API（`databaseadd` / `uploadfile` / `databaseupdate`），
不用在控制台反复点「云端测试」：

```bash
python scripts/seed_cloud.py                  # 体检（只读，不动云端）
python scripts/seed_cloud.py --apply          # 幂等导入，可反复跑
python scripts/seed_cloud.py --apply --reset  # ⚠️ 先清空词库再全量导入（换词表版本时用）
python scripts/seed_cloud.py --apply --skip-audio    # 只导词表与富化
python scripts/seed_cloud.py --apply --force-audio   # 音频全部重传（云存储被误删时）
```

一次跑完五件事：

| 步骤 | 内容 | 幂等方式 |
|---|---|---|
| 词表 | `assets/word_lists/ielts-full.json`（**2987 词**）→ `words` | 按 `word` 去重，已存在的**跳过、不覆盖** |
| 富化 | `assets/examples/pilot-100-examples.json` → `words` 的 `example` / `roots` / `etymology` | 只补 `enriched != true` 的 |
| 单词音频 | `build/audio/manifest.json` → 云存储 `audio/2/*.mp3` + `audio_cache` | 按 `(text, type)` 去重 |
| 例句音频 | `build/sentence_audio/manifest.json` → 同上 | 同上 |
| 点亮 | 有音频的词 `words.audioReady = true` | 只更新 `audioReady != true` 的 |

> 前置：`build/` 里要已有音频产物（第 7 节生成）。只想先把词表灌进去就加 `--skip-audio`。
> 全程约 3 分钟（2987 词 ≈ 60 次批量写；200 个音频 ≈ 400 次请求）。

**`--reset` 清什么**

- 清空 `words` / `user_words` / `records` / `daily_plans`，并把 `users.wordCursor` **归零**
- 保留 `checkins`（打卡）、`audio_cache`（音频索引）、`users`（账号与统计）
- 清空前自动备份到 `build/backup/{集合}-{时间戳}.json`（`build/` 已 gitignore）

> 💡 **为什么换词表必须 `--reset`**：导入语义是「按 `word` 去重、永不覆盖」，
> 直接重导只会把新词**追加**在旧词后面，`seq` 顺序全乱（出词顺序就错了），
> 而且从新词表里删掉的词（`wheels` / `jobs`）会赖在库里不走。

### 6.1 词表是怎么来的（可复现）

词表已是仓库资产：`assets/word_lists/ielts-full.json`（**2987 词**，已做名词复数归一 + 专名剔除）。

也可自己重抽（需要 ECDICT 的 `ecdict.csv`，约 63MB）：

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

### 6.2 控制台路径（等价备选）

不想用本地脚本时，仍可走云函数 `seed_words`：

```bash
python scripts/pack_words.py                          # → build/seed_words/，默认 200 词/批共 15 批
python scripts/fill_token.py --dir build/seed_words   # 把 __ADMIN_TOKEN__ 换成 .env 里的 ADMIN_TOKEN
```

再在控制台 → 云函数 `seed_words` → 云端测试里，把 `build/seed_words/batch-01.json` …
`batch-15.json` 的**整段内容**依次粘进入参框执行。

> 云函数路径的关键语义：按 `word` 去重命中即跳过（**永不覆盖**）；**忽略词表自带的 `seq`**，
> 取库中最大 `seq` 续号（想从 1 开始必须在空库导入）；新词一律 `audioReady: false`。
> ⚠️ 走这条路需要先在云函数环境变量里配 `ADMIN_TOKEN`（见第 3 节）。

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

音频连同 `audio_cache`、`audioReady` 由第 6 节的脚本一并处理，**不用再进控制台**：

```bash
python scripts/seed_cloud.py --apply
```

它做三件事（幂等，失败直接重跑）：

1. 直传云存储 `audio/{type}/{slug}.mp3`（例句是 `s_{hash}.mp3`）
2. upsert `audio_cache`（`text` + `type` → `fileID`，`source: 'preseed'`）
3. **仅单词**：把 `words` 里同名词的 `audioReady` 置 `true` → 从此进入学习队列

> 已入 `audio_cache` 的默认跳过；要强制重传加 `--force-audio`。
> 若坚持走控制台，等价路径是 `seed_audio` 云函数 + `build/seed_audio/batch-*.json`。

### 7.4 例句音频（可选，进阶）

例句文本原本由 `enrich_word` 在运行时生成，要配本地语音必须先把文本离线化：

```bash
# ① 离线生成例句（DeepSeek，prompt 与云端逐字对齐；顺带落盘 roots/etymology）
python scripts/gen_examples.py --wordlist assets/word_lists/pilot-100.json

# ② 合成整句音频
python scripts/gen_sentence_audio.py --examples assets/examples/pilot-100-examples.json

# ③ 预检 + 试听页
python scripts/make_audition_page.py --examples assets/examples/pilot-100-examples.json

# ④ 上传（例句音频与 audio_cache 由 seed_cloud.py 一并处理）
python scripts/seed_cloud.py --apply
```

> 例句音频**不点亮 `audioReady`**（不参与出词）；`audio_cache` 对例句**只查库不兜底**。
> ⚠️ 用 `force: true` 重新生成 AI 内容会让例句文本变化、旧音频失效，需重跑 ②~④。

### 7.5 每日一句音频（12 句）

首页「每日一句」的喇叭走的是**和例句一样的链路**（`playSentence` → `audio_cache` `kind:'sentence'`），
所以这 12 句同样必须**预先入库**。**漏做这一步的症状是「点喇叭没声音，而且没有任何提示」**
（`audio_cache` 查不到 → 返回 `NOT_PRESEEDED` → `playSentence` 静默跳过）。

```bash
# ① quotes.js → 例句脚本能吃的 JSON（quotes.js 恒为唯一数据源）
python scripts/quotes_to_examples.py

# ② 合成整句音频 → build/quote_audio/us/s_{hash}.mp3（12 句约 216KB，CPU 约 7s）
python scripts/gen_sentence_audio.py --examples assets/examples/quotes-12.json \
    --outdir build/quote_audio --types us

# ③ 上传 + 写 audio_cache（默认只体检，--apply 才动云端）
python scripts/seed_quote_audio.py
python scripts/seed_quote_audio.py --apply
```

> 这一步**不走 `seed_audio` 云函数，也不需要 `ADMIN_TOKEN`** —— 直接走云开发 HTTP API 上传云存储并写库。
> ⚠️ 改了 `utils/quotes.js` 里的句子，必须重跑 ①②③（音频以整句文本为 key，改一个字旧音频即失效）。

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

### 云端三处对账（音频是否就绪）

| 位置 | 期望 |
|---|---|
| 云开发 → 存储 | `audio/2/` 下有对应 mp3（例句与每日一句为 `s_*.mp3`） |
| 云开发 → 数据库 → `audio_cache` | 212 条（100 单词 + 100 例句 + 12 每日一句），`source = preseed` |
| 云开发 → 数据库 → `words` | `audioReady = true` 的词 = 100，`seq` 从 1 起连续 |

`python scripts/seed_cloud.py` 体检输出的「复查」段会把这些数直接打出来；
`words` 总数与本地词表（2987）对不上时会告警——那说明漏了 `--reset`。

---

## 9. 常见报错排查

| 报错 | 原因 | 处理 |
|---|---|---|
| `FUNCTION_NOT_FOUND` | 云函数没部署 | 逐个「上传并部署：云端安装依赖」 |
| `Cannot find module 'wx-server-sdk'`（`-504002`） | 该函数目录缺 `package.json`，云端没装依赖 | 补 `package.json`（含 `wx-server-sdk` 依赖）后**重新部署**；核对：`node scripts/check_miniprogram.js` |
| `FunctionName取值与规范不符` | 函数名以下划线开头 | 改成字母开头 |
| `Db not exist` / `collection not exists` | 集合没建 | 跑 `python scripts/init_cloud.py --apply`（见 5.1）或 `init_db`（见 5.2） |
| `ADMIN_TOKEN_NOT_CONFIGURED` | 该函数没配环境变量 | 见第 3 节，注意**函数级隔离** |
| `INVALID_ADMIN_TOKEN` | 入参 `_token` 不对 | 与 `env.ADMIN_TOKEN` 对齐 |
| `INVALID_WORD` | 词名不过 `TEXT_RE` | 字母开头、≤40 字符、仅字母/撇号/连字符/空格 |
| `INVALID_SENTENCE` | 例句不过 `TEXT_RE_SENTENCE` | 见 `seed_audio/index.js` 的排除集正则 |
| `NOT_PRESEEDED` | 例句音频未预置 | 正常现象；跑第 7.4 节补音频 |
| `Cannot create field 'x' in element {y:null}` | 对 `null` 字段做点操作 | 已用 `_.set()` 规避；新代码照抄 `enrich_word` |
| 云函数返回 500 + 网络异常 | 见上，或超时太短 | 核对第 4 节超时表 |
| 发音不响且无报错 | 音频未点亮 / 域名未配 | 查 `audioReady`；若仍走 dictvoice 需配 `downloadFile` 合法域名 `https://dict.youdao.com` |
| 页面空白、数据读不到 | 云开发开了「未登录访问」被关，或权限设错 | 查第 5.3 节安全规则 |
| `init_cloud.py` 报 `40001` / `40125` | `WX_APP_SECRET` 不对或已被重置 | 去小程序后台「开发管理 → 开发设置」重置 AppSecret，更新 `.env` |
| `init_cloud.py` 报 `40164 invalid ip` | 本机公网 IP 不在小程序后台的 IP 白名单 | 小程序后台「开发管理 → 开发设置 → IP 白名单」加上本机出口 IP（`curl ifconfig.me` 查看），或清空白名单 |
| `init_cloud.py` 报 `502003 无权限操作数据库` | 环境 ID 不属于该 AppID | 核对 `miniprogram/config.js` 的 `ENV_ID` 与当前账号 |
| `seed_cloud.py` 报上传 `HTTP 403 SignatureDoesNotMatch` | COS 直传的签名放错位置 | 正常不会遇到：签名必须在 `Authorization` **请求头**、且表单里要带 `key` 字段（见 `wxcloud.py` 的 `upload()`） |
| `seed_cloud.py` 复查告警「云端词数与本地词表不一致」 | 库里有上一版词表的残留 | 加 `--reset` 重导（见第 6 / 10 节） |
| 脚本查数据库**条数莫名少一截**（如 15 条只回 10 条） | HTTP `databasequery` 不带 `.limit()` 时**默认只回 10 条**（小程序 SDK 默认 100，两者不一样） | 所有 `.get()` 带显式 `.limit(n)`（参考 `backfill_queue_roots.py` / `seed_similar.py`） |

---

## 10. 换词表 / 推倒重来

```bash
# 一条命令：自动备份 + 清空 + 重导（细节见第 6 节）
python scripts/seed_cloud.py --apply --reset
```

脚本先把 `words` / `user_words` / `records` / `daily_plans` 备份到 `build/backup/`，再清空重导，
同时把 `users.wordCursor` **归零**。**保留**：`audio_cache`（按 `text` 建索引，重导可复用）、
`checkins`、云存储 `audio/` 目录。

音频也换过的话，按第 7 节重新生成 mp3 后再跑一次（这次不带 `--reset`）。

> 走控制台时等价路径是云函数 `reset_words`：
> `{ "_token": "xxx", "mode": "preview" }` 预检 → `{ "_token": "xxx", "mode": "purge", "confirm": "PURGE" }` 执行。

> ⚠️ 「只删 `words` 再重导」是错的：`user_words.wordId`、`records.wordId`、
> `daily_plans.newWordIds/reviewWordIds/practiceQueue[].wordId` 都引用 `words._id`，
> 只删词会留一地孤儿数据，`wordCursor` 也会错位。

---

## 11. 提审前检查

- [ ] `.env`、`project.private.config.json` 未入库（`.gitignore` 已覆盖）
- [ ] 前端包体内**搜不到 `sk-`**（密钥只在云函数环境变量）
- [ ] 云开发「未登录访问」关闭、无 HTTP 触发路径、无「所有人可写」集合
- [ ] 词库与音频许可：ECDICT（MIT）+ Kokoro-82M（Apache-2.0），保留 `assets/word_lists/ECDICT-LICENSE.txt`
- [ ] 隐私保护指引与代码一致（不收集昵称/头像/微信运动，见 `docs/隐私保护指引.md`）
- [ ] 音频全部自持后，移除 `downloadFile` 合法域名 `https://dict.youdao.com`
- [ ] 服务类目：工具 → 实用工具

## 12. 发布新版本与自动更新

**发布动作**（开发者工具 → 上传）：右上角「上传」→ 填版本号/备注 → 登录微信公众平台
「版本管理」提交审核 → 通过后点「发布」。发布只动**前端包体**，与云函数部署互相独立：
云函数改动走 §4，前端改动走这里。

**自动更新机制**（`miniprogram/app.js` 的 `checkUpdate()`，2026-10-13 加）：
微信客户端会在小程序冷启动时异步检查并下载新版本，但**默认要等下一次冷启动才生效**
（用户得自己杀进程重进）。`app.js` 在 `onLaunch` 用 `wx.getUpdateManager()` 监听
「新版本下载完成」，弹一个不可取消的「立即重启」窗，点一下即用上新版本。

- 发布后**不需要任何额外操作**：用户下次打开小程序就会自动检查、下载、提示重启。
- 只在 `onLaunch` 绑一次 —— `getUpdateManager()` 返回**全局唯一**实例，在 `onShow`
  里重复绑会叠加监听、同一个更新连弹好几次窗。
- 想改成「全自动无感重启」：把 `onUpdateReady` 里的 `showModal` 换成直接
  `um.applyUpdate()`。⚠️ 代价：会硬切串行落库链（`syncAnswer` 在途的那条
  `submit_answer` 可能丢），答题中途重启有数据缺口风险 —— 现在用弹窗正是为了避免它。
- 低版本基础库（没有 `getUpdateManager`）静默降级：走微信默认行为（下次冷启动生效）。
- 本地自测：`node scripts/test_app_update.js`（11 条，钉回调绑定/弹窗契约/applyUpdate）。

**发布后自查**：用自己的微信打开小程序 → 应弹「发现新版本」→ 点「立即重启」→
重启后即为新版本。若没弹：确认公众平台版本状态是**已发布**（审核中/被拒不推送），
或再冷启动一次试试。
