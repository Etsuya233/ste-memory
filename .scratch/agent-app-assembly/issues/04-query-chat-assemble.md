# 04 — 问答面板填写模式迁移到 ST 组装

**Type:** task

**What to build:** 问答面板填写模式改用 02 的组装模块：`composed` = 单条 system 消息（`composeInteractiveProposalAgentSystemPrompt(digest)`，core 已导出的 prompt 文本）+ 用户对话消息列表；交互式软闸门提示词、提交前空间一致性校验、自动落库行为全部不变；查询模式（QueryAgent）不动（规范见 `.scratch/agent-app-assembly/spec.md`）。

**Blocked by:** 02 — ST 层提案 Agent 组装模块

**Status:** ready-for-agent

- [ ] 填写模式改用组装模块：`composeInteractiveProposalAgentSystemPrompt(digest)` 包成 `{ role: "system" }` 编排消息（同形状），digest 在 run 前构建一次
- [ ] 软闸门语义保持：只有正常结束（非取消/超时）才提交冻结提案；`messageRange` 合成占位与零证据注入保持现状
- [ ] 提交链路不动：空间一致性校验（运行中切换对话放弃提案）→ 单事务直通 repository（revisionSource "agent"）
- [ ] 查询模式（QueryAgent）零改动
- [ ] query-chat-service 既有测试全绿（填写模式经 scriptedStreamFn 断言：软闸门提示词进 system prompt、提交前空间校验、自动落库）
- [ ] 插件 typecheck 与测试全绿

## Comments

- 与 03 无依赖关系，02 完成后可并行。
- 本 ticket 是 spec 中「都迁移吧」决策的收尾（03 是主战场，04 是第二个消费方验证组装模块通用性）。
