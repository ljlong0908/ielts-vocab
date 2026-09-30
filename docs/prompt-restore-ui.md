# 原型还原施工提示词（UI + 逻辑）

> 用途：把 `design/prototype.html` 的高保真原型**还原**到 `miniprogram/`（wxml / wxss / js）+ 必要的云函数。
> 用法：整段复制下面的提示词框，粘贴到新会话即可开工。分 4 个阶段，每阶段独立交付、暂停等确认。
> 配套文档：`docs/tasks-ux-miniprogram.md`（M0–M19 改动清单）· `docs/tasks-ux-backend.md`（T1/T2/T5 后端任务）

---

## 复制以下内容

```
# 角色与任务
你是微信小程序工程师。把高保真原型 design/prototype.html 还原到 miniprogram/（wxml/wxss/js），
并按 docs/tasks-ux-miniprogram.md 的 M 清单逐条落地。项目路径 /Users/lijinlong/Projects/ielts-vocab
（个人主体 + 微信云开发，雅思词汇学习小程序「雅词本」）。

# 开工第一步（先读，别凭记忆写）
1. docs/tasks-ux-miniprogram.md  全文（这是施工清单的权威来源，§2 有未拍板决策）
2. docs/tasks-ux-backend.md      §5 与 §8（后端耦合点、幂等结论）
3. design/prototype.html         只读你要还原的那一个 <section class="screen"> 段
4. miniprogram/app.wxss + 目标页的 .wxml/.wxss/.js
5. docs/project-spec.md          业务与数据模型的权威说明

# 权威来源（冲突时的优先级）
- 视觉：design/prototype.html 以它为准；token 对照 design/tokens.html
- 改动范围：docs/tasks-ux-miniprogram.md（M0–M19）
- 后端：docs/tasks-ux-backend.md（T1 加练 / T2 每日一句 / T5 幂等）——**未实施的接口不要接**
- 业务逻辑：以 miniprogram/ 与 cloudfunctions/ 的现有代码为准（原型只是演示，见铁律 7）

# 铁律
1. **不重写页面骨架**。现有 8 个 wxml 已成型（20–63 行），只做差异替换。原型的 class 名与 wxml 同名，
   直接对齐；不要引入新的命名体系。
2. **换算**：wxss 的 rpx ÷ 2 = px（原型按 375px 宽做的）。11px = 22rpx，12px = 24rpx。
3. **wxml 不支持内联 <svg>** → 图标走 iconfont 或 <image>。base64 会膨胀包体
   （10 个图标 ≈30KB，现值 180KB，上限 2MB）。
4. **小程序没有 :active** → <button> 用原生 hover-class；<view> 自己加 .hover 类并在
   touchstart/touchend 切换。
5. **固定底部区必做三件套**：position:fixed + bottom:0；padding-bottom: calc(24rpx + env(safe-area-inset-bottom))；
   **同时给内容区加 padding-bottom**。漏最后一条 = 最后一块内容被永久遮住，这是本项目最高频的错。
6. **不擅自实现待拍板项**。动手前把 §2 的 D5–D11 列成表问我（每条：选项 / 代价 / 你的建议），
   我确认后再写代码。
7. **原型 ≠ 真机**。原型里有演示性的超纲改动，还原前必须回源码核一遍真实行为：
   - 练习页「下一题」手动按钮 → 真机是 practice.js 答对后 setTimeout(next, 900) 自动推进（D6）
   - 统计页日历可点 → 真机纯展示（D8），要做需新增按日查询接口
   - 错题本「错 N 次」badge → 需 user_words 新增字段（D9）
   - 打卡连点：真机已幂等（finish_checkin 按 _openid+date 查重返 already），**别再写防抖**；
     但学习页「下一个」learn.js 的 next() 无锁，必须加 locked。
8. **合规**：grep -rn "雅思" miniprogram/ 必须 0 命中（含注释）；提审文案 docs/intro.md 同样清零。
   「雅思」是他人注册商标，导航标题与分享卡片文案都要改「雅词本」。
9. **mock 层不要动**。config.USE_MOCK 开关 + utils/api.js 的 call() 单点拦截 + utils/audio.js 旁路
   已就位：调试开、交付关。改业务逻辑不需要碰 mock.js。
10. **云函数里还没写的接口**：daily_line（每日一句 T2）、start_extra_round / finish_extra_round
    （加练 T1）**都不存在**。config.FN 里有名字 ≠ 能调。
11. **token 用法约定（比色值更重要）**：--text-3 只做装饰（分隔符、占位图形），承载信息的文字一律
    --text-2；绿字与绿底白字一律 --success-deep，--success 只留给描边与图标。

# 施工顺序（每阶段完成后暂停，等我确认再继续）
阶段① 零依赖（可立即做）：M0 合规 → M15 token → M17 字号 → M1 图标 → M2 热区 → M3 底部规范
      → §3.5 补 app.wxss 缺的类
阶段② 结构（需 D5/D6）：M14 引导页 → M5 tab 栏 → M4 首页 → M6 学习页 → M10 错题本 → M8 打卡降权
      → M7 练习页
阶段③ 接后端（等 T1）：M13 加练 → M7-4 round 参数 → M11 → M9
阶段④ 收口：真机逐页对照原型 → 关 USE_MOCK → 同步文档

# 条目索引（细节一律回文档看，别凭记忆写）
- M0 合规 9 处用户可见：app.json:15 与 pages/index/index.json:2 的导航标题 + 7 处分享文案
  （utils/share.js:36 兜底、pages/index/index.js:15、learn.js:19、practice.js:22、stats.js:19、
  wrongbook.js:13）+ 2 处注释 utils/mock.js:200,202
- M15 token（app.wxss:13,14）：--text-2 #646a73 → #616770；--text-3 #8f959e → #7f8691；
  新增 --success-deep #0f6b4f
- M16 引导页文案区：onboarding.wxml:4 副标题只留「目标要小到不会放弃」；
  「之后可以随时修改」下移成信息条第二行并补出落点「之后可以随时在「我的」里修改」；
  信息条**整条保持不可点**（加了按钮相会被读成第三个选项）
- M17 字号：tab 标签 / 星期字 / 指标名 / 词根标 11px → 12px；胶囊标（tag/badge）保留 11px
- M19a：有固定底栏的页面**不要用 wx.showToast**（位置不可控，会被按钮压住）→ 自绘 toast 或改顶部提示
- M19b：tab 栏形态的固定区，safe-area 避让要写在**外壳**上，不能只写在 .tabbar 里
- M2 热区：8 处小于 88rpx，用 padding / 伪元素扩热区，视觉尺寸可不变
- 完整表格见 docs/tasks-ux-miniprogram.md 的 §3（全局）/ §4（逐页）/ §9（审核结论）

# 验收（每阶段结束都跑，把真实输出贴给我）
node scripts/audit_mobile.js       # 移动端体验审核（热区/对比度/安全区/toast/可达性）→ P0 P1 必须 0
node scripts/test_prototype.js     # 原型业务流程回归（逐词推进/答错重选/打卡/连点保护）
node scripts/test_mock.js          # mock 层 23 用例
node scripts/check_miniprogram.js  # 小程序结构自检（类名/底栏/图标/wxml 配对/云函数三件套）
node scripts/test_learn.js         # 学习页三模式（错题复习 / 今日新词 / 加练）逻辑
node scripts/test_audio.js       # 音频链路（临时链接转换 / 缓存 / 降级）
node scripts/test_wrongbook.js     # 错题本逻辑（点词进复习 / 已掌握 / 失败回滚）
node scripts/test_finish_extra_round.js  # 云函数逻辑无头测试（加练结算：计入累计 / 幂等 / 不污染 streak）
grep -rn "雅思" miniprogram/        # 必须 0 命中
真机另加：开 USE_MOCK:true 逐页比对原型（含扩展内容暂缺 / 生成中 / 词库学完三个边界态）；
滚动到底不被固定底栏遮挡；单手竖握时主 CTA 在拇指可及区内。

# 交付格式
每阶段结束只给我三样：① 改了哪些文件（路径 + 一句话）② 验收命令的真实输出
③ 未解决项 / 需要我拍板的项。
**不要一次性把 4 个阶段全做完**——阶段②依赖决策，做错了要返工。
```

---

## 附：这份提示词为什么这样写

| 段落 | 解决的问题 |
|---|---|
| 开工第一步 | 防止 AI 凭对话印象施工（本项目已出现过「靠印象数合规处数」的误判） |
| 铁律 1、2 | 原型是独立 HTML，直接翻译会引入新命名体系与错误尺寸（rpx÷2 是最易错的一条） |
| 铁律 5 | 固定底部区遮挡是**最高频**的落地错，且表现为「最后一块内容消失」，很难自查 |
| 铁律 6 | §2 有 6 项设计决策未拍板，AI 自选等于替你做产品决定 |
| 铁律 7 | ⚠️ **最关键**：原型里有 4 处演示性超纲改动，照着还原会写出与真机不符的逻辑 |
| 铁律 8 | 合规是硬红线，且分享文案比导航栏更外露（分享出去即公开传播） |
| 铁律 10 | `config.FN` 里有 `daily_line` 但云函数不存在，照着接会 500 |
| 阶段划分 | 阶段①零依赖可立刻开工；②卡决策；③卡后端。混着做必返工 |
| 验收命令 | 四个脚本已就绪，可量化验证，避免「看起来对」 |

**已知待拍板项（开工前需要你确认）**：D5 tabBar 路线（原生 / 自绘）· D6 练习页推进方式（自动 / 手动）· D7 加练显示条件 · D8 日历是否可点 · D9 错题是否记「错 N 次」· D11 引导页承诺行是否做成真入口。
