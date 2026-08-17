# App 层 Agent 独立组装能力

Status: ready-for-agent

## Problem Statement

ADR 0019 已把工具工厂与 Agent 解耦并公开导出，但装配 Agent 所需的运行基础设施（`agent-run.ts` 的 `runAgentWithTimeout` / `convertAgentMessagesToLlm` / `abortedAgentRunSummary` / `RunHooks` / `AgentRunSummary`）未进入 `agent/index.ts` 公开面。`ProposalAgent` 仍是唯一可运行的装配，App 想完全控制 Agent（自定义消息序列、自定义工具集、循环事件处理）会在最后一步卡死，只能复制循环逻辑或回到默认装配。

## Solution

按 ADR 0024（`docs/adr/0024-app-level-agent-assembly.md`）：

1. core 开放运行基础设施公开面（决策 1）；
2. `ProposalAgent` 保留为默认装配，角色降格为 convenience default（决策 2，本 effort 不改任何现有调用方）；
3. 可变性走组合不走参数，`ProposalAgentRunInput` 不加开关（决策 3）；
4. 领域不变量以契约测试锁定在默认装配上（决策 4）。

**范围：只开放能力，不要求迁移。** st-extension 继续用 `ProposalAgent` + `composeMessages` 缝，行为不变。

## Out of Scope

- st-extension 迁移到独立组装（后续按需再开）；
- 新增自定义工具（如内容清洗工具化）；
- ProposalAgent 增加 tools 注入扩展点（若未来需要再评估）。
