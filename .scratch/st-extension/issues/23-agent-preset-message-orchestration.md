# 23 — Agent 提示词预设消息编排：system/user/assistant 消息组合 + char_card/user_card/msg 占位符

**What to build:** Agent 提示词预设从「system prompt 文本片段」升级为「**消息编排**」（ADR 0006 v2）：预设由消息组成，每条消息有角色 system / user / assistant 与模板文本，组合结果 = 编排消息列表（system 合并进系统提示词，user/assistant 进入对话前缀，本轮块提示词追加在最后；对话最后一条必须是 user，core 守卫报错）。编辑器消息卡片增加角色下拉（System/User/Assistant 标签 + 选择器）。新增三个占位符：`{{char_card}}`（当前角色卡 description；群聊 = 群成员角色卡「名字：描述」逐条拼接）、`{{user_card}}`（当前 Persona 描述，powerUserSettings.persona_description）、`{{msg}}`（本块需要总结的消息内容；**引用即接管**——块内容只出现在展开处，不再自动追加块提示词，未引用保持旧行为）。旧版片段（fragments，无角色）在设置合并与导入解析时按 system 消息迁移；导出信封升 v2，v1 文件仍可解析导入。ST 宏注册维持现状（不注册新占位符）。

**Blocked by:** 17 — Agent 提示词预设（片段模型与编辑器先例）；13 — 填表任务（块管线改造点，{{msg}} 按块注入）

**Status:** ready-for-agent

## Decisions

- 编排消息 role 由 `ComposedAgentMessage`（core）承载：system → `AgentState.systemPrompt`（pi 消息类型无 system 角色，系统提示词只经该通道），user/assistant → 初始 transcript 前缀；多条 system 按序空行合并。
- core `ProposalAgent` 新增 `composeMessages` 注入点（digest → ComposedAgentMessage[]），与既有 `composeSystemPrompt` 并存（提供时优先）；apps/api 与问答面板零改动（仍走字符串组合器）。
- 模板模式语义不变：不自动附加 digest；`{{tablesDigest}}`/`{{systemDefaultPrompt}}` 显式引用。
- `{{msg}}` 是块级占位符：任务提交时构造工厂（预设解析 + 世界书扫描 + ST 上下文快照一次），块处理时按块调用 compose(msgText)；`containsMsgReference` 判定接管语义（零引用零开销）。
- 角色卡 / Persona 在任务提交时快照一次（`adapter.getPromptSnapshot`）；群聊 char_card = 群成员角色卡拼接（群聊 {{char}} = 群名，成员名字靠这里补）。
- 设置持久化与导入导出双迁移：旧 `fragments` 键 → messages（role=system）；导出信封 v2，解析兼容 v1。
- 新占位符暂不注册 ST 全局宏（填表任务专属语义）；`{{char_card}}`/`{{user_card}}`/`{{msg}}` 与 ST 内建宏（charDescription/persona 等）无重名。

## Comments

（实现说明：core 组合器缺省仍走 `composeSystemPrompt`（字符串路径），`composeMessages` 提供时优先——编排消息为空 = system prompt 空 + 无前缀，模板模式无安全兜底；run 校验放宽为「run 消息为空 + 编排消息兜底」（{{msg}} 接管场景），并新增「组合后最后一条必须是 user」守卫。）
