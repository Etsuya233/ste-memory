# 01 — core：开放 Agent 运行基础设施公开面 + 默认装配契约测试

**Type:** task

**What to build:** ADR 0024 决策 1 与决策 4 的实施。

- 把 `core/src/memory/application/agent/agent-run.ts` 已导出的运行基础设施补进 `agent/index.ts` 公开面（re-export）：
  - `runAgentWithTimeout`
  - `convertAgentMessagesToLlm`
  - `abortedAgentRunSummary`
  - `RunHooks`
  - `AgentRunSummary`
- 验证 App 层组装路径可走通（不依赖 `ProposalAgent`）：用公开零件 + pi-agent-core 的 `Agent` 组装一个最小 run（`new Agent` + `convertToLlm: convertAgentMessagesToLlm` + `runAgentWithTimeout`），作为契约测试的一部分锁定——证明"导出即可用"，防止公开面退回私有。
- 契约测试（决策 4）：把 `ProposalAgent` 默认装配的领域不变量显式锁进 `core` 测试（现为隐式成立）：
  - digest 每次 run 构建一次，提示词与工具共用同一 digest；
  - system 角色合并进系统提示词，user/assistant 进入初始 transcript（本轮消息之前）；
  - 对话最后一条消息必须是 user（含编排消息参与校验，违反即抛错）；
  - ProposalState 每 run 新建（run 间状态不泄漏）；
  - 总超时 = 硬中止（abort 语义，不等待当前轮）。
- **行为零变化**：`ProposalAgent` 现有调用方（api `chat-manager`、api `fill-task-service`、扩展 `FillTaskService`）零改动。

**Status:** resolved

**验收:**
- `core` 全部测试通过（含新增契约测试）；
- `agent/index.ts` 公开面包含上述 5 个符号；
- App 组装 smoke 测试通过（公开零件可直接装配运行）；
- `apps/` 与 `apps/st-extension/` 无 import 变更（行为零变化验证）。

## Answer

已实现（未提交）：`agent/index.ts` 公开面新增 `runAgentWithTimeout` / `convertAgentMessagesToLlm` / `abortedAgentRunSummary` + `RunHooks` / `AgentRunSummary` 类型；新增 `core/test/agent/agent-run-contract.test.ts`（9 例）：公开面导出、App 层组装 smoke（公开零件 + pi-agent-core Agent 直接装配跑通）、convert 过滤自定义角色、aborted 摘要形状、runAgentWithTimeout 超时硬中止/AbortSignal 取消、ProposalAgent 契约（digest 每 run 新建、State 每 run 新建 tempId 从 1 开始、timeoutMs 硬中止）。core agent 子层 62 测试全绿；typecheck 通过；apps 侧零改动。全量测试在并发下存在基线 flaky（api chat/query-records/current-records 等随机失败，无改动时同样复现，失败用例每次漂移），与本次改动无关（单跑全过）。

评审后补充（code-review 2026-08）：
- 5 条契约不变量的覆盖分布：digest 每 run 新建 / State 每 run 新建 / 超时硬中止由本文件锁定；「system 角色合并」「最后一条必须 user」由既有 `proposal-agent.test.ts`（消息编排 describe 块）锁定，契约测试合计覆盖完整。
- 「提示词与工具共用同一 digest」无直接断言（实现上 `proposal-agent.ts` 同一局部变量传入两边，结构成立，接受弱覆盖）。
- 边界观察（不修，避免防御性代码）：公开的 `runAgentWithTimeout` 对已预中止的 AbortSignal 无前置检查（`ProposalAgent.run` 内部有）；未来 App 直接使用时若需要该语义，应在公开函数补 `hooks.signal?.aborted` 检查。
