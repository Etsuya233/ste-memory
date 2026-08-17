# 25 — st-extension 记忆视图：视图配置 + 宏参数展开 + 设置面板 CRUD + 世界书文档

**What to build:** 记忆视图（ADR 0025）落地：插件级命名视图 {名称、表 Key、筛选条件（v1 单条件：字段 Key + 值集合）、条数上限（可选）、显示字段投影（可选）}，存插件设置；记忆宏升级为带一个可选视图名参数的注册（`{{宏名::视图名}}`，无参 = 现有默认快照行为不变）；每视图一个预计算快照，指纹轮询重建 + 视图 CRUD kick；设置面板「记忆宏」组扩展视图列表 CRUD；输出经 core 统一表达式求值（ticket 24）+ 视图渲染（投影「字段名：值」拼接 / 无投影用 displayText）；世界书用法文档。

**Blocked by:** 24 — core 统一表达式

**Status:** ready-for-agent

## Decisions

- **宏注册升级**：沿用用户可配置宏名（默认 `{{memoryContext}}`），`unnamedArgs: [{ name: 'viewName', optional: true, defaultValue: '' }]`；handler 同步按参数查快照 Map（默认快照 + 每视图快照）；未知视图名/空参数 → 空串 + 日志（宿主 console，不阻断）；两个以上参数 → ST 参数校验失败（文档说明）。注册端口签名从 `() => string` 改为接收参数（`MacroExecutionContext` 子集），st-chat-adapter 适配。
- **视图设置模型**：插件设置新增 `memoryViews: [{ name, tableKey, condition: { fieldKey, operator, values } | null, limit: number | null, projection: string[] }]`；名称校验：非空、不含空白/`::`/`|`/`}}`、全局唯一（中文可用）；合并时非法视图丢弃。
- **快照架构**：每视图预计算文本（表 Key → 表记录 → core 统一表达式求值 → 投影渲染或 displayText 单行化 → 条数/字符上限截断）；重建判定 = 指纹变化（含表/记录/字段定义变化）+ 视图设置变化（kick）；视图缺表/缺字段 → 该视图快照 = 空串 + 日志。
- **渲染**：投影 = 「字段名：值」按视图字段顺序拼接（空值省略，引用字段显示为目标记录 displayText，复用查看模式解析逻辑）；无投影 = displayText；输出不含分组标题、不含 `{{...}}`；视图级字符上限兜底（缺省 = 全局 macroLimit）。
- **面板 UI**：记忆宏组下视图列表 CRUD（名称输入 + 表选择 + 筛选字段/值选择（枚举字段选项下拉，short_text 手输）+ 条数输入 + 显示字段多选）；改动即写设置 + `macro.kick()`。
- **世界书文档**：宏放 WI 条目内容即按关键词触发注入（ST 激活时展开，含自定义宏；constant 条目 = 常驻注入变体）；预算按展开后计 token → 用视图条数/上限控制；`experimental_macro_engine` 关闭后自定义宏不展开（既有风险）。

## 验收

- 宏展开：无参 = 默认快照（与 ticket 15 输出契约逐字一致）；`{{宏名::视图名}}` = 视图快照；未知视图名 = 空串不阻断；视图 CRUD 后 kick 立即生效。
- 筛选/条数/投影语义对照 ticket 24 契约测试（真机：伏笔表「排除已回收/已放弃」、剧情表「最后 N 条」）。
- 设置合并非法视图丢弃；视图名校验（空白/`::`/`|`/`}}`/重复）在 UI 与合并层双守卫。
- 真机验收（`docs/playwright-st-extension/` 延续 verify-memory-macro 先例）：宏放 WI 条目（关键词触发）真实生成展开；预算展示；面板冒烟。

事实调研：`docs/research/st-macros-args-and-worldinfo.md`；设计决策：ADR 0025。
