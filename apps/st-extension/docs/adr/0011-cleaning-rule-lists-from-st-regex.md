# 填表任务内容清洗：导入 ST 正则条目为插件级清洗规则列表

spec 决策 #9「清洗规则不移植，ST Regex 由用户自行负责」被反转：ST 的 Regex 扩展只作用于生成时提示词构建（getRegexedString），从不改写 chat 数组——用户配的 ST 正则对插件填表任务的输入**根本不会生效**。决定：插件引入**插件级命名的清洗规则列表**（存 `extension_settings.steMemory.cleaningRuleLists`，纯模型 + 设置存储端口，同 Agent 预设/连接先例），每个对话经 chatMetadata **独立新键**（`steMemoryCleaningList`，镜像键先例：旧版本忽略新键、绑定读取路径零改动）选择一份列表；填表任务处理块时实时读取所选列表的规则，只清洗喂给 Agent 的消息内容（运行记录 Prompt 快照自动跟随），证据与展示层保持原文。清洗规则以「保留/去掉/替换」三种模式执行（读取时应用，原文永不改写，同 apps ADR 0001 精神）。

**导入语义**：来源 = ST 全局正则条目（`getContext().extensionSettings.regex`，官方 API 唯一可达作用域）+ ST 正则扩展导出的 JSON 文件（覆盖角色卡 scoped 与预设条目，格式与 ST 自身导入一致）。每条按替换串语义映射——`replaceString` 去空白后为空 → 去掉；**其余一律 → 替换模式**（`{{match}}` 展开为 `$0`，`$1`/`$<name>` 走 JS 原生替换语义）；`/pattern/flags` 包裹解析为 pattern + flags（ST 允许但 JS 非法的 flags x/X/A/J/U 丢弃），未包裹默认 `g`；placement 与「用户输入/AI 输出」无交集的条目跳过（只作用于 MD 显示/斜杠命令/世界书/推理的条目对消息清洗无意义）；trimStrings、宏替换（substituteRegex）、markdownOnly/promptOnly、runOnEdit、min/maxDepth 等 ST 专属字段不迁移，差异在导入报告中逐条说明。**导入永远追加**，不记录来源 id、不去重——重复导入产生重复规则，由用户自行清理。

> 修正记录（code review 2026-08）：纯组引用（`$1`/`$0`/`{{match}}`）**不**映射为「保留」模式——ST 的替换语义是「匹配段替换、保留匹配间文本」（"a **b** c" 配 `\*\*(.+?)\*\*` + `$1` → "a b c"），而保留模式是「全内容替换为捕获拼接」（→ "b"），且 `$0`/`{{match}}` 在 ST 中为 no-op、导入为保留会变成破坏性提取。改为一律映射到替换模式后与 ST 行为逐字一致；「保留」模式仍保留给手动创建（api/web 语义对齐）。

## Considered Options

- **严格映射（仅保留/去掉，其余跳过）**：与 api/web 模型完全一致，但最常见的清洗脚本（`(\*\*|__)(.*?)\1 → $2` 类提取内层）会被跳过，导入功能对主力用例失效。拒绝。
- **全保真（replace + trimStrings + placement 角色定向）**：模型膨胀，trimStrings/按发送者定向 v1 无实际使用场景。拒绝（未来可选）。
- **每记忆空间一份列表（对齐 api/web）**：每个对话都要重复导入，违背「ST 全局正则脚本全局生效」的心智模型。拒绝。
- **列表选择并入现有绑定对象**（`steMemory` 加字段）：有把新值误判为 unrecognized、整块指针被保留冻结的风险。拒绝，选独立键。

## Consequences

- 反转 spec 决策 #9 与 Out of Scope 的「清洗规则移植」条目；同一列表可被多个对话共享，改列表/改规则对后续任务追溯生效。
- 列表是全局配置：不进 Dexie、不进备份/R2 云同步（与 Agent 预设、连接、R2 密钥一致）。
- 导入后的规则与 ST 原脚本行为存在差异（无 trimStrings、无宏展开、无按发送者定向、默认全局匹配），导入报告负责说明；用户可在 ST 正则扩展里调好再导入，或导入后在本插件内行内编辑。
- 「清洗规则」成为 core 与两个客户端共享的领域词汇（提升至 core/CONTEXT.md）；「清洗规则列表」「ST 正则条目」为插件专属词汇（apps/st-extension/CONTEXT.md）。
- 列表被删除时引用方回退为不清洗：插件只能读到当前对话的 chatMetadata，无法扫描所有对话文件，故不做「引用中禁止删除」。
