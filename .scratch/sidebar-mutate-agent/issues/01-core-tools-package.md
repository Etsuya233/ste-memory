# 01 — core：工具定义移入 agent/tools/ 子包 + 交互式填写 prompt

**Type:** task

**What to build:** 工具定义与 Agent 解耦（spec 决策 5），并新增交互式填写的 system prompt（spec 决策 4）。

- 移动 5 个工具工厂到 `core/src/memory/application/agent/tools/` 子包，按域分目录：
  - `tools/query/query-records-tool.ts`
  - `tools/proposal/`：`mutate-tool.ts`、`proposal-preview-tool.ts`、`drop-mutate-tool.ts`、`submit-proposal-tool.ts` + 工具支撑 `proposal-state.ts`、`proposal-tool-error.ts`、`proposal-compiler.ts`
- `digest.ts` 留在 `agent/` 根（prompt 组合器与工具共用）；`agent/tools/` 提供 index 导出；`agent/index.ts` 公开导出不变（外部消费者仅 QueryAgent/ProposalAgent/工具工厂按需调整）。
- QueryAgent / ProposalAgent 保留为薄装配，**填表任务行为零变化**。
- `prompt-composer.ts` 新增 `composeInteractiveProposalAgentSystemPrompt(digest)`：基于 digest，指令含「先查询现状 → 陈述将执行的变更并询问用户 → 用户明确同意后才可调用 submit_proposal → 提交成功后结束对话；用户未同意或无需变更时不调用 submit_proposal」；无消息范围/证据框架。

**Status:** resolved

**验收:** `core` 测试、架构测试（pi 依赖仅限 agent 子层）通过；填表任务相关测试全绿；工具工厂经 `tools/` 新路径导出可正常装配。

## Answer

已实现（0411f84）：8 个文件移入 `agent/tools/{query,proposal}/`（git mv，公开导出面零变化）；`composeInteractiveProposalAgentSystemPrompt` + `ProposalSystemPromptComposer` 类型；ProposalAgent 支持注入自定义 prompt 组合器；新增 prompt-composer 测试（5 例）。core 115 测试全绿。
