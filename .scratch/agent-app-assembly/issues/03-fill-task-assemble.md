# 03 — 填表任务迁移到 ST 组装

**Type:** task

**What to build:** 填表任务块循环直接编排消息并走 02 的组装模块，删除 `createComposeMessages` / `FillTaskPromptFactory` 三层嵌套 seam；楼层范围、分块、安全点、清洗、块证据、批次事务、台账、运行日志行为全部不变（规范见 `.scratch/agent-app-assembly/spec.md`）。

**Blocked by:** 02 — ST 层提案 Agent 组装模块

**Status:** ready-for-agent

- [ ] `FillTaskServiceOptions.createComposeMessages` 替换为 `createPromptContext`（提交时构造一次，返回**纯数据** `{ preset, snapshot } | undefined`，无方法；内部 = 预设解析 + 世界书扫描 + ST 上下文快照，归属 runtime 装配）
- [ ] 块循环直接编排：digest = `buildMemorySpaceTableDigest`（块内构建一次，喂消息展开与工具装配）；`composed` = 活动预设 ? `composePresetMessages(preset, {...snapshot, msgText})` : `composeProposalAgentMessages(digest)`（默认预设路径，core 文本函数同形状）
- [ ] `{{msg}}` 接管：`messages` 数组由 service 直接决定——`containsMsgReference(preset)` 为真时 `[]`，否则追加块提示词（referencesMsg 不再单独存储）
- [ ] `composePresetMessages` 纯函数保留（预设 + 块文本 + digest → `ComposedAgentMessage[]`）；`FillTaskPromptFactory` 类型删除
- [ ] 块证据、清洗、事务提交、运行日志逻辑不动；run 结果消费对齐组装模块返回形状
- [ ] fill-task-service 既有测试全绿（原 createComposeMessages 注入测试改写为新路径断言：system 消息展开进 system prompt、`{{msg}}` 接管 `messages=[]`、无预设走默认提示词）
- [ ] 插件 typecheck 与测试全绿

## Comments

- 与 04 无依赖关系，02 完成后可并行。
- 行为变化（spec 已确认接受）：删除「最后一条必须 user」守卫，assistant 结尾预设直接进入 run。
