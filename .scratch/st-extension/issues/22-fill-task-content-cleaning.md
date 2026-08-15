# 22 — 填表任务内容清洗：ST 正则条目导入为清洗规则列表

**What to build:** 填表任务内容清洗（反转 spec 决策 #9，见 ADR 0011）：插件级命名的**清洗规则列表**（存 `extension_settings.steMemory.cleaningRuleLists`，纯模型 + 设置存储端口，同 Agent 预设先例），每个对话经 chatMetadata 独立键（`steMemoryCleaningList`，值 `{version:1, listId}`，镜像键先例：旧版忽略、绑定读取路径零改动）选择一份列表；填表任务块处理时**实时读取**所选列表规则，只清洗喂给 Agent 的消息内容（证据与展示层保持原文），未选择/列表已删 → 不清洗（现状兼容）。列表 CRUD（建/改名/删；删除不阻止，引用方回退不清洗）+ 规则行内编辑（name/mode/pattern/flags/replacement/enabled/删除/重排，position = 数组下标）。

**导入**（设置 Tab「清洗规则」区块）：来源 = ST 正则条目（全局 `extension_settings.regex` + 当前角色卡 scoped + 当前预设，三源均经 getContext() 官方 API 可达，按脚本 id 去重）+ ST 导出 JSON 文件（数组或单对象；覆盖非当前角色卡等其余条目）；导入目标 = **当前编辑列表（无需选择；无列表时新建并填名）**；候选条目**默认不勾选**、手动选择，条目只显示来源标签（全局/角色/预设/文件）+ 名称（跳过条目带原因）；导入报告（新建 N / 跳过 K + 每跳过的原因，跳过条目确认后仍在报告中）。映射：`replaceString` 去空白后为空 → 去掉；其余一律 → 替换（`{{match}}` 展开 `$0`；`$1`/`$<name>` JS 原生语义，与 ST 行为逐字一致；不映射为保留——ST 替换保留匹配间文本，见 ADR 0011 修正记录）；`/pattern/flags` 包裹解析（非 JS flags x/X/A/J/U 丢弃并报告）；未包裹默认 `g`；placement 与 {用户输入, AI 输出} 无交集 → 跳过；trimStrings/substituteRegex/markdownOnly/promptOnly/runOnEdit/min/maxDepth 忽略并报告。**永远追加**，不记来源 id、不去重。任务触发 UI 显示当前列表名（未选择提示「未启用清洗」）。

**Blocked by:** 13 — 填表任务手动触发与运行（块管线改造点）；17 — Agent 提示词预设（设置区块 UI 先例）

**Status:** ready-for-agent

## Decisions（grilling 会话产出，见 ADR 0011）

- 列表存插件设置（不进 Dexie/备份/R2）；规则 shape = `{ name, mode: keep|discard|replace, pattern, flags, replacement? }` + enabled。
- 聊天→列表选择 = chatMetadata 独立新键（不并入 `steMemory` 绑定对象，避免 unrecognized 风险）。
- 应用范围 = 填表任务输入仅；改列表/改规则追溯生效（读取时应用，apps ADR 0001 精神）。
- 同一列表多聊天共享；未选择 = 不清洗（默认关闭、显式启用）。
- 与 api/web 的「清洗规则」共享 core 词汇（已提升）；插件专属词汇「清洗规则列表」「ST 正则条目」已入 st-extension/CONTEXT.md。

## Comments

（grilling 会话产出：Q1 导入来源、Q2 映射保真度（+replace 模式）、Q3 全局多列表+每聊天自选、Q4 仅任务输入、Q5 placement 过滤、Q6 永远追加、Q7 设置 Tab+行内编辑、Q8 存插件设置、Q9 chatMetadata 独立键、Q10 未选择/删除回退不清洗、Q11 导入目标列表、Q12 实时读取+共享。）
