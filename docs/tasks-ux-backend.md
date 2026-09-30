# UX 优化 · 后端接口任务单

> **状态**：待实现（有 4 项前置决策未拍板，见 §2）
> **关联文件**：`design/index.html`（视觉原型）· `miniprogram/utils/mock.js`（前端 mock）· `docs/project-spec.md`（结构与业务）
> **前端配套**：`docs/tasks-ux-miniprogram.md`（小程序待改清单）—— 加练按钮 / `round` 参数接线 / 错 N 次 badge 等前端落点都在那份文档，本文只管云函数与数据模型
> **云函数改动**：现有 15 个 → 17 个（新增 2 个）

---

## 1. 背景与范围

近几轮 UX 优化在**首页原型**上新增了两个功能元素，其中「再学一组」需要后端配套（新增接口 + 现有状态机改造）；「每日一句」需要决策是否后端化。底部 tab 栏为纯前端改动。

| 编号 | 需求 | 涉及云函数 | 类型 | 优先级 |
|---|---|---|---|---|
| **T1** | 再学一组（加练） | `start_extra_round`(新) `finish_extra_round`(新) `today_flow` `build_questions` `submit_answer` `home_summary` | 新增 + 改造 | P0 |
| **T2** | 每日一句 | `daily_line`（**仅方案 B 需要**） | 新增 | P2（建议不做） |
| **T3** | 底部 tab 栏 | — | **纯前端**，见 §4 | P1（前端） |
| **T4** | 章末：索引/部署/文档同步 | — | 配套 | P0 |
| **T6** | 错题本「已掌握」（用户追加，非原型项） | `dismiss_wrong`(新) + `stats`(改造：错题查询排除 `mastered`) | 新增 + 改造 | ✅ **已实现**（2026-09-29），规格见 `project-spec.md` §4.5 / §11.10 |

> 注：T5（幂等与连点）在 §8 单独登记，不占上表。

---

## 2. 前置决策项（需产品确认后才可动工）

> ⚠️ 这 4 项直接改变接口设计，**未确认前不要开始写 T1 代码**。

### D1 · 「再学一组」按钮的显示条件

| 选项 | 语义 | 影响 |
|---|---|---|
| **A（推荐）** | 仅当日**已打卡**后显示 | 加练与打卡彻底解耦，不会与主流程状态机竞争；接口只需校验「今日已打卡」 |
| B | 学习中（progress）也显示 | 需额外定义「今日进度 2/5 + 加练 5 词 = 7/5」如何呈现，进度卡会溢出，且 `learnedToday` 语义要重新定义 |

**推荐 A**：加练是"任务外的额外收获"，与今日计划并列而非混合，语义最干净。

### D2 · 每组词数

- 选项①：沿用 `user.dailyGoal`（5 或 10）
- 选项②：固定 5 词
- **推荐①**，与用户设置保持一致；但需处理 `dailyGoal=10` 时词库余量的边界（见 T1 边界表）。

### D3 · 是否计入「累计学习」(`totalLearned`)

- **最终决策：计入**（= 本文档原始推荐值）。加练的词确实进了用户的词汇量，不计算是数据失真。
  中途曾按用户当日选择落成「不计入」，**2026-09-29 用户明确要求改回计入** →
  `finish_extra_round` 结算时 `users.totalLearned += wordIds.length`。
- 但**不计入** `streak`、**不写** `checkins`（打卡是"完成当日任务"的凭证，加练不是）。
- ⚠️ 两个实现要点：
  1. **只在结算时按整组入账**，不是「学一个加一个」—— 与 `finish_checkin` 用 `plan.newWordIds.length` 完全对称。
     中途退出（学了一半不做小测）不入账；这些词因 `wordCursor` 未推进，次日会被 `start_new_words`
     当新词重新取到，届时由 `finish_checkin` 计入 —— **不会漏计，只是延后**。
  2. **幂等分支（组 `stage === 'done'`）绝不重复累加** —— 这是本函数唯一的计数风险点，
     已由 `scripts/test_finish_extra_round.js` 覆盖（重复 + 三连结算用例）。

### D4 · 每日一句的实现路径

| 方案 | 做法 | 成本 | 推荐 |
|---|---|---|---|
| **A（强烈推荐）** | 前端静态语料 `utils/quotes.js`，按日期取模 | **零后端改动**，零延迟 | ✅ |
| B | 云函数 `daily_line` + `quotes` 集合 | 多一次冷启动、多一个集合 | ❌ |
| B+ | 云函数从**当日新词的例句**里挑一句 | 关联学习内容，有额外价值 | 可选升级 |

**理由**：每日一句**无个性化需求**（同一句对所有用户无差别），后端化只增加延迟与运维面，不产生价值。100 句语料放前端足够轮一年。若将来要做 B+（从今日词例句里挑），那时再上云函数。

---

## 3. T1 · 再学一组（加练）详细规格

### 3.1 现有状态机（改造前，务必先理解）

`daily_plans` 单文档保存当日全部状态，`stage` 流转：

```
review ──(复习全对)──> learning ──(学完新词)──> practice ──(练习全对)──> practice_done ──(打卡)──> done
```

关键字段与归属：

| 字段 | 写入者 | 说明 |
|---|---|---|
| `reviewWordIds` / `reviewQueue` | `today_flow` / `build_questions` | 复习池 |
| `newWordIds` / `learnedIds` | `start_new_words` / `today_flow(markLearned)` | 当日新词 |
| `practiceQueue` | `build_questions` | **含 `answerIndex`，不下发** |
| `stage` | `submit_answer` / `finish_checkin` | 状态机 |

### 3.2 ⚠️ 四个必须绕开的技术冲突（本任务的核心难点）

| # | 冲突 | 现状证据 | 对策 |
|---|---|---|---|
| **C1** | `daily_plans` 唯一索引 `_openid + date` → **一天只能一条 plan** | `assets/db-indexes.json` 第 59-67 行 | 加练组**内嵌**为 `plan.extraRounds[]`，不另建文档、不改索引 |
| **C2** | `finish_checkin` 用 `plan.newWordIds` 算 `learnedCount` 并推进 `wordCursor` | `finish_checkin/index.js:52-67` | 加练词**绝不写入** `newWordIds`，独立字段存放 |
| **C3** | `submit_answer` 在练习全对时**无条件**写 `plan.stage` | `submit_answer/index.js:88-92` | 加练答题必须携带 `round` 参数，**仅 `round===0` 才改 `plan.stage`** |
| **C4** | 队列存在 plan **顶层**字段，加练复用会覆盖当日主练习 | `build_questions/index.js:81` `submit_answer/index.js:29` | 加练队列存在 `extraRounds[i].practiceQueue`，靠 `round` 参数路由 |

> **C4 是最容易踩的坑**：如果不加 `round` 参数隔离，加练的 `build_questions` 会**直接覆盖**当日主练习的 `practiceQueue`，导致用户重进练习页看到的是加练题——主流程被静默破坏，且因为是同一字段，排查时很难定位。

### 3.3 数据模型改动

`daily_plans` 新增字段（**无需数据迁移**，读取处一律 `plan.extraRounds || []` 兜底）：

```js
{
  // ...现有字段不变
  extraRounds: [
    {
      roundId: 1,               // 当日自增序号，从 1 开始
      wordIds: [],              // 本组词（后端定，前端只用 wordIds 取卡）
      learnedIds: [],           // 已学标记（与主流程 learnedIds 同语义）
      practiceQueue: [],        // 练习题，含 answerIndex，不下发
      stage: 'learning',        // 'learning' | 'practice_done' | 'done'
      startedAt: Date,
      finishedAt: Date | null
    }
  ]
}
```

**索引**：`extraRounds` 不参与查询条件（只按 `_openid + date` 取出整条 plan），**无需新增索引**。

### 3.4 接口规格

#### ① `start_extra_round`（新增云函数）

```js
// 调用
wx.cloud.callFunction({ name: 'start_extra_round', data: {} })

// 返回
{ code: 0, data: {
    roundId: 1,
    wordIds: ['xxx', 'yyy', ...],
    reused: false,          // true = 复用未完成的组，未新建
    exhausted: false        // true = 词库剩余不足一组，按钮应置灰
} }
```

**业务规则**：
1. 校验当日 plan 存在（不存在 → `code:-1, message:'请先初始化当日计划'`）
2. **前置校验（D1 选 A 时）**：今日未打卡 → `code:-1, message:'完成今日打卡后可加练'`
3. **幂等**：若 `extraRounds` 末尾存在 `stage !== 'done'` 的组 → 直接返回该组（`reused:true`），**不新建**
4. ~~**上限**：当日 `extraRounds.length >= MAX_ROUNDS_PER_DAY`~~ → **已取消（2026-09-29）**：用户要求「不限次数」，`MAX_ROUNDS_PER_DAY` 置为 `Infinity`。唯一的自然终点是词库取尽（取词为空 → `exhausted:true`）。常量与判断代码保留原位，将来要恢复上限只改常量
5. 取词：`{ seq: _.gt(user.wordCursor), audioReady: true }`，`orderBy('seq','asc')`，`limit(dailyGoal)`
   - ⚠️ 须**排除** `plan.newWordIds` 与所有 `extraRounds[].wordIds` 中已出现的 id
   - ⚠️ 遵守项目硬约束：**只出 `audioReady === true` 的词**（见 `MEMORY.md` 硬约束章节）
6. `wordIds.length === 0` → 返回 `exhausted: true`，**不创建空组**
7. 追加新组并落库，返回

> ⚠️ **不推进 `wordCursor`**。游标推进只发生在"该组学完"时（见 ②），与现有"打卡才推进"的语义一致。若用户在加练中途退出，这些词次日会被 `start_new_words` 重新取到——这是**正确行为**（没学完就重来），不是 bug，但要在前端文案上避免让用户困惑。

#### ② `finish_extra_round`（新增云函数）

```js
// 调用
wx.cloud.callFunction({ name: 'finish_extra_round', data: { roundId: 1 } })

// 返回
{ code: 0, data: {
    roundId: 1,
    learnedCount: 5,
    totalLearned: 178,      // 更新后的累计
    already: false          // true = 该组已完成过（幂等）
} }
```

**业务规则**：
1. 定位 `plan.extraRounds` 中 `roundId` 匹配的组（不存在 → 报错）
2. 该组 `stage === 'done'` → 幂等返回 `already: true`
3. 校验该组 `practiceQueue` 全部 `passed === true`（否则报错，与 `finish_checkin` 同规则）
4. 推进 `user.wordCursor` 到本组 `wordIds` 的 **max(seq)**（**复用 `finish_checkin:58-67` 的写法**，不能按词数累加）
5. `users.totalLearned += wordIds.length`（**D3=计入**；口径与 `finish_checkin` 的 `newWordIds.length` 对称，**且只在这一步**，幂等分支不重复加）
6. 本组词注册进 `user_words` 复习池（**完全复用 `finish_checkin:90-111` 的 upsert 逻辑**，`nextReviewDate = 次日`）
7. 标记该组 `stage = 'done'`、`finishedAt = now`
8. ⛔ **不写 `checkins`**、⛔ **不改 `streak` / `lastCheckinDate`**、⛔ **不改 `plan.stage`**

#### ③ `today_flow`（改造）

新增返回字段（**向后兼容，老前端忽略即可**）：

```js
{ code: 0, data: {
    plan,                    // 现有
    dailyGoal, streak, totalLearned,   // 现有
    extra: {                 // 新增
      canStart: true,        // 是否可发起加练（D1 前置 + 词库余量；上限已取消）
      pendingRound: null,    // 未完成的组 { roundId, wordIds } | null
      roundsToday: 1,        // 当日已完成组数
      extraLearnedToday: 5   // 当日加练学到的词数（供首页展示）
    }
} }
```

⚠️ **注意现有逻辑陷阱**：`today_flow:90` 处，已打卡时把 `plan.stage` **强制改写为 `'done'`** 并且这个改写**没有落库**（只改内存对象）。加练不依赖 `stage`，所以不受影响，但实现时别顺手把它改成写库——会破坏状态机的可追溯性。

#### ④ `build_questions`（改造）

```js
// 新增可选入参 round，默认 0（= 当日主流程，保持现有行为）
wx.cloud.callFunction({
  name: 'build_questions',
  data: { phase: 'practice', round: 1 }
})
```

路由规则：
- `round === 0`（或未传）→ 读/写 `plan.practiceQueue`（**现有行为不变**）
- `round > 0` → 读写 `plan.extraRounds[round-1].practiceQueue`
- 出题词源：`round > 0` 时用 `extraRounds[i].wordIds`
- 干扰项池、`sanitize()`、1:1 题型混合逻辑**全部复用**，不改

#### ⑤ `submit_answer`（改造）

同样新增 `round`（默认 0）。**关键改动点在 `index.js:88-92`**：

```js
// 现状（会污染主流程）
const allPassed = queue.every((x) => x.passed)
const patch = { [key]: queue, updatedAt: new Date() }
if (allPassed && phase === 'review') patch.stage = 'learning'
if (allPassed && phase === 'practice') patch.stage = 'practice_done'
await plans.doc(plan._id).update({ data: patch })

// 改造后
const allPassed = queue.every((x) => x.passed)
if (round > 0) {
  // 加练：只更新组内队列与组 stage，绝不触碰 plan.stage
  await plans.doc(plan._id).update({
    data: { [`extraRounds.${round - 1}.practiceQueue`]: queue,
            [`extraRounds.${round - 1}.stage`]: allPassed ? 'practice_done' : 'learning',
            updatedAt: new Date() }
  })
} else {
  // 主流程：沿用现有逻辑
  const patch = { [key]: queue, updatedAt: new Date() }
  if (allPassed && phase === 'review') patch.stage = 'learning'
  if (allPassed && phase === 'practice') patch.stage = 'practice_done'
  await plans.doc(plan._id).update({ data: patch })
}
```

> ⚠️ **`records` 流水照常写**（错题本依赖它），但 `phase` 字段建议存 `'practice'`（不区分加练），避免 `records` 的 `isCorrect` 索引查询口径变化。若产品要求区分，加独立字段 `round`，**不要改 `phase` 取值**。

#### ⑥ `home_summary`（改造）

新增返回 `extraLearnedToday`（当日加练词数，用于首页进度卡展示"2/5 ＋ 5 加练"）。

### 3.5 边界与异常清单

| 场景 | 期望行为 |
|---|---|
| 词库剩余 `audioReady` 词 < 一组 | `exhausted: true`，前端按钮置灰 |
| 用户连续点两次「再学一组」 | 幂等：第二次返回同一 `pendingRound`，`reused: true` |
| 加练中途退出，次日再进 | 未学完的词次日由 `start_new_words` 重新取出（游标未推进）—— 符合预期 |
| 加练组题目未全对就调 `finish_extra_round` | 报错 `'仍有未答对的题目'`（与 `finish_checkin` 一致） |
| 跨天（23:59 发起，00:01 提交） | `today` 按服务端 `dateStr(0)` 判定，会落到"次日"的 plan → 报 `'请先初始化当日计划'`。**已知边界，不处理**，在文档记录即可 |
| ~~当日加练已达上限~~ | **已取消**（2026-09-29 不限次数）。此时唯一的「发不出来」是词库取尽 → `exhausted:true`，前端置灰并提示「预置发音的词已学完」 |
| 同一用户并发两次 `start_extra_round` | 依赖 `extraRounds` 末尾 `stage !== done` 的幂等判定；极端并发下可能创建两组，**可接受**（不引入分布式锁） |

### 3.6 验收标准

- [ ] 未打卡时调 `start_extra_round` 被拒（D1 选 A）
- [ ] 连点两次只创建一组
- [ ] 加练答题后，`plan.practiceQueue`（主练习队列）**未被修改** ← C4 回归重点
- [ ] 加练答题后，`plan.stage` **未被修改** ← C3 回归重点
- [ ] 加练完成后 `checkins` 集合**无新增记录**、`users.streak` **未变化**
- [ ] 加练完成后 `users.wordCursor` 推进到本组 max(seq)，且**次日 `start_new_words` 不重复出这些词**
- [ ] 加练学完的词出现在 `user_words`，`nextReviewDate` = 次日
- [ ] `totalLearned` 增加量 = 本组词数；**重复调用不再增加**（幂等，D3=计入）
- [ ] 词库取尽时 `exhausted: true`

---

## 4. T2 · 每日一句（仅在 D4 选 B 时实施）

### 方案 B 规格（不推荐，仅备档）

```js
// wx.cloud.callFunction({ name: 'daily_line', data: {} })
{ code: 0, data: {
    text: 'It does not matter how slowly you go as long as you do not stop.',
    cn: '走得慢不要紧，只要不停下。',
    author: 'Confucius',
    tags: ['毅力', '坚持'],
    date: '2026-09-29',
    audioFileID: 'cloud://...'   // 可选
} }
```

- 数据：新增 `quotes` 集合（字段 `text` / `cn` / `author` / `tags` / `active`），或直接静态数组打在云函数内（**更简单，推荐后者**）
- 选句：`dayIndex = floor(Date.UTC(y,m,d) / 86400000) % quotes.length`（与前端 mock 算法一致，保证可复现）
- 语料已备好 **12 句**，见 `miniprogram/utils/mock.js` 的 `DAILY_LINES`；落地时扩到 100 句左右
- 选句硬标准（**加句时必须遵守，已在 `scripts/test_mock.js` 里做了自动体检**）：≤18 词 / 可迁移（本身是雅思素材）/ 必配中文对照

### 方案 B+ （可选升级：与学习内容关联）

从**当日新词的例句**里挑一句（`words.example.en`），价值更高但需定义"挑哪一句"的规则（如最长句 / 含高频搭配）。**建议 V2 再做**。

---

## 5. T3 · 底部 tab 栏（纯前端，此处仅登记约束）

`app.json` 当前**没有 `tabBar` 配置**，8 个页面均为普通页面。两条路：

| 路线 | 做法 | 代价 |
|---|---|---|
| 原生 tabBar | `app.json` 配 `tabBar.list` | `stats`/`wrongbook`/`profile` 必须改用 `wx.switchTab` |
| 页面内自绘 | 每页画 `position:fixed; bottom:0` 的栏 | 4 个页面各复制一份，需自己维护选中态 |

> ⚠️ **`wx.switchTab` 不支持 URL 参数**。当前这三页无带参需求，可走原生 tabBar；若将来要给错题本带 `filter` 之类的参数，原生 tabBar 会挡住这条路（需改用 `globalData` 或缓存传递）。
>
> 另：自绘栏必须用 `env(safe-area-inset-bottom)` 避让 Home 条，触控热区 ≥ 88rpx。

---

## 6. T4 · 配套改动清单（别漏）

| 类别 | 文件 | 动作 |
|---|---|---|
| 云函数 | `cloudfunctions/start_extra_round/` | 新增 `index.js` + `config.json`（**函数名不得以下划线开头**） |
| 云函数 | `cloudfunctions/finish_extra_round/` | 同上 |
| 前端常量 | `miniprogram/config.js` | `FN` 加 `START_EXTRA_ROUND` / `FINISH_EXTRA_ROUND` |
| 前端封装 | `miniprogram/utils/api.js` | 加 `startExtraRound()` / `finishExtraRound()` / `buildQuestions({round})` |
| mock | `miniprogram/utils/mock.js` | 加对应 mock（含 `exhausted` / `pendingRound` 边界态） |
| 自测 | `scripts/test_mock.js` | 加用例，保持全绿 |
| 数据清单 | `assets/db-indexes.json` | **无需改**（未新增索引） |
| 部署文档 | `docs/deploy.md` | 云函数数 15 → 17；补两个名字 |
| 业务文档 | `docs/project-spec.md` | 补加练状态机说明 |
| 概览 | `README.md` | 云函数清单更新 |

**部署**：新增云函数需在开发者工具「上传并部署（云端安装依赖）」，或本地 CLI 批量部署（见 `deploy.md`）。

---

## 7. 风险清单

| 风险 | 等级 | 说明 |
|---|---|---|
| 加练覆盖主练习队列 | **高** | C4，若 `round` 参数路由写错会静默破坏主流程，**必须按 §3.6 做回归** |
| 加练污染 `plan.stage` | **高** | C3，同上 |
| `wordCursor` 推进写错 | **中** | 项目硬约束：游标必须按 **seq** 推进，不可按词数累加，否则音频有缺口时游标错位、重复出词 |
| 加练词重复计入 `totalLearned` | **中** | 幂等靠组 `stage === 'done'` 判定，需覆盖"重复调用"用例。**已固化回归**：`scripts/test_finish_extra_round.js`（首次结算 / 重复 / 三连 / 未全对 / 组不存在 / 空词组 / 三组累加，共 21 条；并做过负向验证） |
| 一天多组导致文档膨胀 | 低 | 每组 ~5 个 id + 队列。**上限取消后**理论上一天可开很多组，但受 `audioReady` 词池（当前 100）自然封顶，极端情况也就几十组、几百个 id，远未触及 16MB 文档上限 |
| 跨天边界 | 低 | 已知且不处理，见 §3.5 |

---

## 8. T5 · 幂等与连点（移动端体验审核新增）

移动端审核里「连点 / 重复提交」类问题一共 2 处。**逐条回到云函数核对后，只有 1 处真要动，另 1 处是文案与行为不一致**——先把结论留档，免得反复返工。

### 8.1 T5-0 · 已核实：打卡**不需要改**（结论留档）

| 检查点 | 位置 | 结论 |
|---|---|---|
| 接口幂等 | `cloudfunctions/finish_checkin/index.js:42-46` | 按 `_openid + date` 查 `checkins`，命中直接返回 `{ already: true }`，**不累加** `streak / totalLearned` ✅ |
| 前端挡连点 | `miniprogram/pages/checkin/checkin.wxml:2` | `wx:if="{{loading}}"` 把按钮换成「打卡中」✅ |
| already 态文案 | `miniprogram/pages/checkin/checkin.wxml:7` | `{{already ? '今日已打卡' : '打卡成功'}}` ✅ |

> ⚠️ **反倒是原型错了**：`design/prototype.html` 的 `doCheckin()` 此前没复刻 already 语义，会演示出一个**真机上不存在**的"重复打卡"缺陷。
> 已修（新增 `state.checkedToday` 判定 + 注释指向 `finish_checkin/index.js:42-46`）。
> **教训**：审核工具量的是**原型的行为**，不等于**真机的行为**——落文档前必须回源码核一遍。

### 8.2 T5-1 · `submit_answer` 缺幂等 ⚠️ **要做**

**现状**：`cloudfunctions/submit_answer/index.js:43` 无条件 `records.add({...})`。连点 / 网络重试会在 `records` 里落下**多条同题记录**，直接污染两处下游：正确率统计、复习排期（`nextReviewDate`）。

**要求**：
- 加幂等键：建议 `_openid + planId + questionId`（或 `_openid + date + questionId`）。命中已有记录时**返回既有结果**，不再插入、不改排期
- 或退一步在 `records` 上建**唯一索引**（清单加到 `assets/db-indexes.json`，走 `scripts/init_cloud.py` 落库）
- 前端配合：答题按钮提交期间禁用（见前端单 §9.4）

**验收**：同一题连续提交 3 次 → `records` 只多 1 条，三次返回体一致，`nextReviewDate` 不被推后。

> 📌 `submit_answer` 正是 **T1 加练**要改的同一个函数（`round` 参数）。**建议与 T1 合并实施**，否则两次改动会在同一段代码上互相踩。

### 8.3 T5-2 · 每日目标修改的生效时点（文案与行为不一致，需拍板）

- **文案**（`miniprogram/pages/profile/profile.wxml:29`）：**「修改后从下一个自然日生效」**
- **实际行为**：
  - `cloudfunctions/user_profile/index.js:40-43` 的 `setGoal` **立刻**写 `users.dailyGoal`
  - `cloudfunctions/start_new_words/index.js:63` 取词时才按**当时**的 `dailyGoal` 生成 `plan.newWordIds`；`:59-60` 之后命中 `reused: true` 复用
- **结论**：当天**已开始学习**后再改目标 → 文案成立 ✅；当天**还没开始学习**就改 → 当天立刻按新目标出词，**文案不成立** ❌

| 选项 | 做法 | 代价 | 附带收益 |
|---|---|---|---|
| **A 改文案** | 改成「当天已开始学习的话，改动从下一个自然日生效」 | 便宜，纯前端文案 | 无 |
| **B 改行为**（推荐） | 建 `daily_plans` 时把 `dailyGoal` **快照**进 `plan`，`start_new_words` 只读快照 | 要改 2 个函数的读写路径 + 补历史数据口径 | 文案完全成立，且**历史计划的词数不再随目标漂移**（回看统计更准） |

> 选 A → 前端 `profile.wxml:29` 同步改文案；选 B → 本文登记为 T5-2 实施项，前端文案不动。

---

## 附：一句话总结

**核心只有一件事**——把「加练」作为 `plan.extraRounds[]` 内嵌进当日计划，并用 `round` 参数把 `build_questions` / `submit_answer` 的读写路由到正确的队列，**绝不触碰 `plan.stage`、`newWordIds`、`checkins`、`streak` 这四样主流程资产**。其余都是样板代码。
