# Agent 提示词预设：消息编排 + 模板模式 + 自研占位符展开，不接 ST MacroEngine

表格填写 Agent 的提示词可被用户预设覆盖：预设 = 命名档案，内含**消息**（命名 + 角色 + 内容 + 开关 + 排序），启用消息按序经**占位符展开**后成为本轮对话的编排消息。全局一个**活动预设**；内置只读的**系统默认预设**（等价于未配置时的行为）作回退锚点。

## 消息编排（v2，取代纯 system prompt 文本）

预设由**消息**组成而非文本片段：每条消息有角色 `system` / `user` / `assistant` 与模板文本。组合时：

- `system` 角色消息按序合并进系统提示词（空行分隔）——pi 的消息类型无 system 角色，系统提示词只经 `AgentState.systemPrompt`（每次请求置于最前）；多条 system 消息的次序在合并文本内保留；
- `user` / `assistant` 角色消息进入对话**前缀**（初始 transcript，run 的本轮消息之前），角色与顺序原样保留——用户可编排「开场设定 → 示例对话 → 最终指令」式的多轮形态；
- 本轮任务消息（块提示词）始终追加在编排消息之后；对话最后一条必须是 user 消息（core 守卫，违者明确报错）。

core 侧：`ProposalAgent` 新增 `composeMessages` 注入点（digest → `ComposedAgentMessage[]`），与既有 `composeSystemPrompt` 并存（提供 `composeMessages` 时优先；缺省走字符串组合器，apps/api 与问答面板零改动）。**模板模式语义不变**：编排消息不会自动附加 digest，`{{tablesDigest}}` / `{{systemDefaultPrompt}}` 显式引用。

## 占位符自研展开，不接 ST MacroEngine

ST 的宏引擎（`MacroEngine`）不暴露任意文本展开的公共 API，静态 import 会被 esbuild 打进 bundle——与插件「只经 `getContext()` 适配器、永不静态 import ST 代码」的隔离策略冲突（ticket 12 确立）。故自研白名单替换器（单遍展开，未知占位符原样保留）：

- `{{user}}`（name1）、`{{char}}`（单角色 name2 / 群聊=群名，与 ST 内建宏的「群聊=当前角色名」语义不同，刻意为之）；
- `{{char_card}}`（当前角色卡 description；群聊 = 群成员角色卡「名字：描述」逐条拼接——群聊 `{{char}}` = 群名，成员名字靠这里补）、`{{user_card}}`（当前 Persona 描述，`powerUserSettings.persona_description`，ST 随 persona 切换同步）；
- `{{msg}}`（本块需要总结的消息内容，格式与块提示词正文一致；**引用即接管**——块内容只出现在 `{{msg}}` 展开处，不再自动追加块提示词，见「{{msg}} 接管语义」）；
- `{{tablesDigest}}`（composer 内用 run 时 digest 现算，无需预计算快照）、`{{systemDefaultPrompt}}`（默认提示词全文）；
- `{{worldbook}}`（任务提交时一次 ST 扫描快照，ADR 0007）。

`{{tablesDigest}}` / `{{systemDefaultPrompt}}` 同时注册为 ST 全局宏（与记忆宏同模式），用户可在角色卡/提示词中使用；不注册 `{{user}}`/`{{char}}`（与 ST 内建宏重名会覆盖+警告）；`{{char_card}}`/`{{user_card}}`/`{{msg}}` 暂不注册 ST 全局宏（填表任务专属语义，v2 最小集）。

**{{msg}} 接管语义**：`{{msg}}` 是块级占位符（每块内容不同），引用它的预设 = 用户接管消息编排——块内容只出现在展开处，服务不再追加块提示词；未引用 = 保持 v1 行为（块提示词作为本轮用户消息追加在编排消息之后）。零引用零开销：服务按 `containsMsgReference` 判定，无引用时不为 `{{msg}}` 做任何额外工作。

## 快照与迁移

任务提交时一次快照：对话双方名字、角色卡 / Persona 文本、世界书扫描文本；`{{msg}}` 按块注入。旧版**片段**（fragments，无角色）在设置合并与导入解析时按 `system` 消息迁移（旧行为 = 全部进系统提示词）；导出信封升 v2（`messages` + `role`），v1 文件仍可解析导入。

**不选方案**：接 `MacroEngine` 展开全部 ST 宏生态（破隔离策略、bundle 膨胀、版本耦合）；digest 自动追加（用户失去完全控制）；占位符注册为 ST 宏后依赖 ST 生成期展开（Agent 提示词不经 ST 组装，无人展开）；`{{group}}` 占位符（群聊 char=群名已覆盖）；任务行记录预设快照（Dexie schema 变更，任务列表展示全局当前预设名即可）；编排消息只允许 system 角色（消息编排的意义就是 user/assistant 可编排）；`{{msg}}` 与块提示词并存追加（内容重复，用户被迫猜语义）。
