# 记忆视图：记忆宏表达式化 + 世界书注入

Feature spec。设计决策：`docs/adr/0025-memory-views-and-memory-query.md`；ST 事实调研：`docs/research/st-macros-args-and-worldinfo.md`。

## Problem Statement

记忆宏（ticket 15，`.scratch/st-extension/issues/15-memory-macro.md`）把「全部启用表」的预计算快照注入提示词文本，但只能全量注入——用户要「只展示未完成的伏笔」「最后几条剧情条目」这种**按需选取**（筛选、条数、显示字段），并希望内容能放进**世界书条目**按关键词触发注入，而不是只能放角色卡/系统提示/作者注释。

## Solution

插件提供**命名记忆视图**：用户在设置面板配置 {表格、筛选条件、条数上限、显示字段}，然后在提示词预设或世界书条目中放置 `{{宏名::视图名}}` 展开该视图。无参数的 `{{宏名}}` 保持现有行为（全部启用表）。视图的选取经 core **记忆查询**（既有查询契约，查询 Agent 工具与 apps HTTP 查询共用，补 in/not_in 多值算子）执行——同一套读侧语言，无第二套实现。世界书**零插件改动**：ST 1.18.0 在 WI 条目激活时无条件展开自定义宏，插件只需文档说明。

## User Stories

1. 作为用户，我可以配置命名记忆视图（选择表格、筛选条件、条数上限、显示字段），以便按需注入记忆内容
2. 作为用户，我可以在提示词预设或世界书条目中放置 `{{宏名::视图名}}`，以便展开指定视图
3. 作为用户，我可以对枚举字段配置多值筛选（如伏笔状态排除已回收/已放弃），以便只注入未完成的伏笔
4. 作为用户，我可以配置视图条数上限，以便只注入最近 N 条剧情条目（按更新时间倒序）
5. 作为用户，我可以配置视图显示字段（投影），以便输出行包含状态等字段
6. 作为用户，视图输出与查询 Agent 同语义（同一记忆查询契约），以便行为可预期
7. 作为用户，我把宏放入世界书条目内容后按关键词触发注入，以便内容只在相关上下文出现
8. 作为用户，视图引用的表/字段不存在（含字段 Key 被改名）时展开为空串，以便配置错误不阻断生成
9. 作为用户，视图配置变更后立即生效，以便无需重启或重开对话
10. 作为用户，无参宏保持原有行为（全部启用表），以便现有配置不受影响
11. 作为用户，视图名可用中文且全局唯一，以便直接以语义命名

## Implementation Decisions

1. **单宏 + 视图名参数**：沿用用户可配置宏名（默认 `{{memoryContext}}`），注册为带一个可选位置参数（`unnamedArgs`）的宏。无参 → 现有默认快照（全部启用表分组、updatedAt 倒序、字符上限截断，行为不变）；带参 → 该命名视图的快照；未知视图名/空参数 → 空串 + 日志，不阻断生成。两个以上参数 → ST 参数校验失败（文档说明）。视图名受 ST 宏参数语法约束：不含空白、`::`、`|`、`}}`（中文可用）。
2. **记忆视图 = 插件级命名配置**：存插件设置（与清洗规则列表同层），全局生效。字段：名称、表 Key、筛选条件（v1 单条件：字段 Key + 值集合，single_select/short_text 字段）、条数上限（可选）、显示字段投影（可选）。视图缺失、表/字段缺失（含字段 Key 被改名）→ 展开空串 + 日志（翻译层错误可在面板显示）。
3. **求值 = 记忆查询（既有查询契约）**：视图的选取翻译成 `QueryRecordsInput`（`fieldIds` = 投影、`conditions` = 筛选（多值 = `in` 算子）、`order` = `$updated_at` desc、`paging.pageSize` = 条数上限），经 `MemorySpaceReader` 端口执行——查询 Agent 工具、apps HTTP 查询与记忆视图共享同一契约与实现（api SQLite / st-extension Dexie 双实现），**不新建独立求值器**。契约补 `in`/`not_in` 算子（`value` 为数组，`MemoryFieldValue` 已支持），`query_records` 工具参数 schema 与描述同步更新（LLM 面受益：多值查询无需拆多次 equals）。视图无条数上限时用 pageSize 100（契约上限；全局字符上限兜底截断使其实际影响不可见，文档说明）。
4. **投影**：视图可选显示字段；渲染 = 「字段名：值」按视图字段顺序拼接（空值省略，引用字段显示为目标记录显示文本，需渲染层解析引用）；无投影 → 沿用查询结果的显示文本（displayText）。输出不含分组标题（视图是单表语义）。**输出文本不含 `{{...}}`**（整条 prompt 还会过一次 substituteParams，避免二次展开）。
5. **世界书零插件改动**：用户把宏放进 WI 条目内容即可（ST 激活时展开，含自定义宏；预算按展开后内容计 token）；插件不自动维护 WI 条目（`loadWorldInfo/createWorldInfoEntry/saveWorldInfo` 能力存在但不采用）、不改写 ST 预设文件（`getPresetManager` 能力存在但不采用）。交付物 = 文档 + 视图能力。
6. **快照架构不变**：每视图一个预计算快照 + 默认快照；重建 = 视图翻译成记忆查询**异步**执行（`MemorySpaceReader.queryRecords`）→ 渲染 → 缓存文本，宏 handler 仍同步返回（无冲突）；指纹轮询重建；视图 CRUD（设置变化）kick 立即评估。**默认快照维持 ticket 15 现状**（`listTables` + `listRecords` + `assembleMemoryContextSnapshot`），不迁移到记忆查询（已验收行为不动）。
7. **宏注册端口签名变更**：`MemoryMacroRegistrationPort.register` 的 handler 从 `() => string` 改为接收参数（`MacroExecutionContext` 子集，`unnamedArgs`），st-chat-adapter 适配。

## Testing Decisions

- **原则**：只测外部行为（端口契约、纯函数输入输出），不测实现细节（不测 IndexedDB 内部、不测 ST DOM）。沿用 st-extension「唯一纯逻辑 seam」理念。
- **记忆查询契约（core/test/ 既有 seam）**：in/not_in 算子×字段类型校验矩阵、成员匹配语义、空数组/元素类型不符拒绝、列表字段组合拒绝、`$record_id` in、与排序/分页/投影组合语义不变、工具 schema 解析（先例：`core/test/agent/query-records-tool.test.ts`）。
- **视图纯逻辑（st-extension 唯一 seam）**：翻译层（视图 → QueryRecordsInput：投影/条件/排序/分页映射，缺表/缺字段报错）、渲染层（投影「字段名：值」拼接、displayText 兜底、空值省略、截断、输出不含 `{{...}}`）、设置合并（memoryViews 校验/丢弃：名称非法/重复、条件形状损坏）、宏服务扩展（带参注册、多快照、重建判定含设置变化、kick、未知视图名空串）——fake 端口 + fake timers（先例：`memory-macro-service.test.ts`、`plugin-settings.test.ts`）。
- **视图 UI**：CRUD 模型（名称校验、表/字段选择器状态、投影多选、条数输入）+ 组件冒烟（先例：`cleaning-rules-manager-model.test.ts` + `cleaning-rules-manager.test.tsx`）。
- **手动验收**（不进 CI，延续 `verify-memory-macro.mjs` 先例）：宏放 WI 条目（关键词触发）真实生成展开、预算展示、`{{宏名::视图名}}` 展开、无参宏回归、面板冒烟。

## Out of Scope

- OR/嵌套条件、行模板、每空间视图、投影字段运算、多条件 UI（契约已支持多条件与 10 个算子，仅差 UI 暴露）
- 插件自动维护 WI 条目 / 改写 ST 预设文件（`setExtensionPrompt` 运行时注入留作自动注入方案的备选）
- 管道过滤器（`{{x|filter}}`，ST 1.18.0 未实现）

## Further Notes

- ST 宏参数语法约束（参数内无空白，`::`/`|`/`}}` 特殊，中文可用——源码已核实，见事实调研）。
- `experimental_macro_engine` 关闭后自定义宏不展开（既有风险，文档提示，本 feature 不处理）。
- 视图无条数上限时翻译为 pageSize 100（契约上限），全局字符上限兜底截断使其实际影响不可见。
- 字段 Key 被改名会使引用它的视图失效（展开空串 + 日志，面板可显示配置错误）。
- 世界书预算按展开后内容计 token——用视图条数/上限控制；constant WI 条目 = 常驻注入变体。
