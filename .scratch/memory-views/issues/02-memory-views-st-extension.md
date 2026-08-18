# 02 — st-extension 记忆视图：视图配置 + 宏参数展开 + 记忆查询翻译 + 设置面板 CRUD + 世界书文档

**What to build:** 记忆视图（ADR 0025）落地：插件级命名视图 {名称、表 Key、筛选条件（v1 单条件：字段 Key + 值集合，single_select/short_text 字段）、条数上限（可选）、显示字段投影（可选）}，存插件设置；记忆宏升级为带一个可选视图名参数的注册（`{{宏名::视图名}}`，无参 = 现有默认快照行为不变）；每视图快照 = 视图翻译成**记忆查询**（core 查询契约，ticket 01 的 in 算子）经 `MemorySpaceReader.queryRecords` **异步**执行 → 渲染 → 缓存，宏 handler 仍同步返回；指纹轮询重建 + 视图 CRUD kick；设置面板「记忆宏」组扩展视图列表 CRUD；世界书用法文档。

**Blocked by:** 01 — core 记忆查询 in/not_in 算子

**Status:** ready-for-agent

## Decisions

- **宏注册升级**：沿用用户可配置宏名（默认 `{{memoryContext}}`），`unnamedArgs: [{ name: 'viewName', optional: true, defaultValue: '' }]`；handler 同步按参数查快照 Map（默认快照 + 每视图快照）；未知视图名/空参数 → 空串 + 日志（宿主 console，不阻断）；两个以上参数 → ST 参数校验失败（文档说明）。注册端口签名从 `() => string` 改为接收参数（`MacroExecutionContext` 子集），st-chat-adapter 适配。
- **视图设置模型**：插件设置新增 `memoryViews: [{ name, tableKey, condition: { fieldKey, values } | null, limit: number | null, projection: string[] }]`；名称校验：非空、不含空白/`::`/`|`/`}}`、全局唯一（中文可用）；合并时非法视图丢弃。
- **翻译层（纯函数，有测试）**：视图 → `QueryRecordsInput`——`fieldIds` = 投影（无投影省略 = 返回全部启用字段）；`conditions` = `[{ fieldId: 筛选字段, operator: 'in', value: values }]`（恒用 in，单值 = 单元素数组）；`order` = `{ fieldId: '$updated_at', direction: 'desc' }`；`paging` = `{ page: 1, pageSize: limit ?? 100 }`（契约 pageSize 上限 100；无条数上限时取 100，全局字符上限兜底截断使其实际影响不可见，文档说明）。表/字段 Key 经 digest 校验映射为 id；digest 用 `buildMemorySpaceTableDigest(reader, spaceId)` 构建（先例：`agent-presets/agent-macro-service.ts:149`，宿主注入 reader 端口）；缺表/缺字段 → 翻译失败 → 该视图快照 = 空串 + 日志（面板可显示配置错误）。
- **渲染（纯函数，有测试）**：无投影 → 查询结果的显示文本（displayText）单行化；有投影 → 「字段名：值」按视图字段顺序拼接（空值省略；引用字段显示为目标记录显示文本——查询结果 values 里引用为裸 id，需复用现有引用解析补充查询，先例：`ui/record-view.tsx` 查看模式的引用解析逻辑）；输出不含分组标题、不含 `{{...}}`；字符上限用**全局 macroLimit** 兜底（视图无独立上限字段）。
- **快照架构**：默认快照维持 ticket 15 现状（`listTables` + `listRecords` + `assembleMemoryContextSnapshot`，不迁移）；视图快照重建 = 翻译 → `reader.queryRecords`（async）→ 渲染 → 缓存；重建判定 = 指纹变化 + 视图设置变化（kick）；失败单轮保旧值。端口扩展：`MemoryMacroServicePorts.data` 现只有 `listTables`/`listRecords`，需补 `reader: MemorySpaceReader`（或 `queryRecords` 端口），运行时接线复用 `runtime.ts` 已组装的 reader（含 `queryRecords` → `MemoryRecordQueryService`，行 188 附近）。
- **面板 UI**：记忆宏组下视图列表 CRUD（名称输入 + 表选择 + 筛选字段/值选择（枚举字段选项多选，short_text 手输）+ 条数输入 + 显示字段多选）；改动即写设置 + `macro.kick()`。
- **世界书文档**：宏放 WI 条目内容即按关键词触发注入（ST 激活时展开，含自定义宏；constant 条目 = 常驻注入变体）；预算按展开后计 token → 用视图条数/上限控制；`experimental_macro_engine` 关闭后自定义宏不展开（既有风险）。

## 验收

- 宏展开：无参 = 默认快照（与 ticket 15 输出契约逐字一致）；`{{宏名::视图名}}` = 视图快照；未知视图名 = 空串不阻断；视图 CRUD 后 kick 立即生效。
- 筛选/条数/投影语义（真机）：伏笔表「排除已回收/已放弃」（in 多值）、剧情表「最后 N 条」（`$updated_at` desc + pageSize）、投影「名称/线索/状态」渲染、无投影 displayText、无条数上限取 100 行为。
- 设置合并非法视图丢弃；视图名校验（空白/`::`/`|`/`}}`/重复）在 UI 与合并层双守卫。
- 真机验收（`docs/playwright-st-extension/` 延续 verify-memory-macro 先例）：宏放 WI 条目（关键词触发）真实生成展开；预算展示；面板冒烟。

事实调研：`docs/research/st-macros-args-and-worldinfo.md`；设计决策：ADR 0025。
