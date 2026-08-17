# 02 — ST 层提案 Agent 组装模块

**Type:** task

**What to build:** 新建插件侧共享组装模块 `src/agent/`，作为填表任务与问答面板填写模式的统一 Agent 运行入口（规范见 `.scratch/agent-app-assembly/spec.md`，接口草案在该 spec 的「组装模块接口草案」小节，允许按实现调整）：接收调用方已展开的编排消息（`ComposedAgentMessage[]`）+ 本轮消息 + digest + 证据 + 消息范围，装配 5 个提案工具并跑通完整 Agent 循环，返回与 `ProposalAgentRunResult` 对齐的结果（含冻结提案）。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 编排：system 角色合并进系统提示词（空行分隔），user/assistant 进初始 transcript（插件自实现，约 10 行；core 不导出编排方法）
- [x] 守卫：仅「组合后至少一条消息」抛错；不复制 core `ProposalAgent` 的「第一条/最后一条必须 user」守卫
- [x] 装配：`ProposalState`（每 run 新建）+ 校验闭包（`validateProposalOperation` / `validateProposalOperations` / `previewProposal` 包装）+ 5 个工具工厂（`createQueryRecordsTool` / `createMutateTool` / `createProposalPreviewTool` / `createDropMutateTool` / `createSubmitProposalTool`）+ `new Agent`（pi-agent-core）
- [x] run：`runAgentWithTimeout`（超时/取消语义沿用 core）；`proposal` 取 `state.frozenProposal`；digest 由调用方传入（模块不内置 digest 构建）
- [x] 模块单测（fixture digest + scriptedStreamFn）：守卫抛错、system 合并、前缀顺序、run 结果形状、submit_proposal 冻结提案
- [x] 插件 typecheck 通过；esbuild 构建通过（pi-agent-core 从 type-only 变运行时依赖，打进单文件 bundle）

## Answer

`apps/st-extension/src/agent/fill-agent-runner.ts`：`runFillAgent(input: FillAgentRunInput)` 函数式组装模块（`FillAgentRunInput` 在 spec 接口草案基础上补充 `digest` 字段——digest 由调用方传入，模块不内置构建）。system 合并（空行分隔）/user+assistant 前缀构造为 ST 自实现（`systemTextOf` / `toAgentPrefixMessages`）；守卫仅「组合后至少一条消息」抛错；每 run 新建 `ProposalState` + 校验闭包 + 5 工具工厂 + `new Agent`；`runAgentWithTimeout` 沿用 core 超时/取消语义，结果形状对齐 `ProposalAgentRunResult`。单测 7 个（Dexie fixture digest + scriptedStreamFn）全绿；插件 typecheck 与 esbuild 构建通过（pi-agent-core 变运行时依赖打进单文件 bundle，~1024kb）。

## Comments

- 本 ticket 是纯新增、无消费方也能独立验证；03/04 两个 service 迁移都阻塞于它。
