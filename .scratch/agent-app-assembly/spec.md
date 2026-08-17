# ST 层独立组装 Agent（ADR 0024 实践落地）

Status: ready-for-agent

## Problem Statement

插件目前通过 core 的 `ProposalAgent` 默认装配运行填表与问答填写：ST 的 Agent 预设（消息编排）、世界书、块文本必须挤进 `composeMessages` 回调 seam，形成 `createComposeMessages(storyText) → compose(blockText) → composer(digest)` 三层嵌套；编排链无法脱离 Agent 单独测试，理解"模型看到什么"要跨 7 个文件。而 core 并不读 ST 业务——预设、世界书、块文本都是 ST 概念，下沉 core 是错误方向。ADR 0024 已开放 App 层组装能力（digest/工具工厂/校验闭包/run 基础设施/prompt 文本全部公开），插件应直接使用这些零件在 ST 层组装 Agent。

## Solution

ST 层直接组装 pi-agent-core 的 `Agent`：插件持有全部编排权（预设消息展开 → system 合并 → 对话前缀 → 本轮消息），core 只提供零件（digest 构建、5 个提案工具工厂、ProposalState、校验闭包、run 基础设施、prompt 文本）。新建共享组装模块 `src/agent/`，填表任务与问答面板填写模式共用；`ProposalAgent` 及其三层嵌套 seam 从插件侧删除（api 侧继续使用，不受影响）。core 零代码改动。

## User Stories

1. 作为插件开发者，我想在 ST 层直接组装 Agent（`new Agent` + core 工具工厂 + run 基础设施），以便完全控制消息编排，不再受 core `ProposalAgent` 装配的约束
2. 作为插件开发者，我想让 core 只提供零件（工具工厂、prompt 文本、digest、校验闭包、run 基础设施），以便 core 不读 ST 业务（预设/世界书/块文本）
3. 作为插件开发者，我想删除 `createComposeMessages` / `FillTaskPromptFactory` 三层嵌套，以便理解"模型看到什么"只在一个模块内
4. 作为插件开发者，我想让预设展开直接产出最终 Agent 消息（保留 `composePresetMessages` 纯函数），以便编排链可脱离 Agent 单独测试
5. 作为插件用户，我想填表任务的楼层范围、分块、安全点、清洗、台账、日志行为与之前完全一致，以便升级无感
6. 作为插件用户，我想预设含 `{{msg}}` 时块内容只出现在占位符处（referencesMsg 语义），以便既有预设兼容
7. 作为插件用户，我想问答面板填写模式（交互式软闸门提示词、提交前空间校验、自动落库）行为与之前一致
8. 作为插件开发者，我想让填表与问答填写共用同一组装模块，以便装配知识（digest 生命周期、ProposalState、校验闭包、5 工具）集中一处
9. 作为插件开发者，我想 run 结果形状对齐 `ProposalAgentRunResult`（messages/stopReason/errorMessage/answer/proposal），以便 service 消费代码改动最小
10. 作为插件开发者，我想编排守卫只保留"组合后至少一条消息"，以便预设角色顺序自由（删除"第一条/最后一条必须 user"）
11. 作为插件开发者，我想 service 层测试继续通过 `createLlm` 注入 scriptedStreamFn 的结构，以便测试改造影响最小
12. 作为插件开发者，我想 pi-agent-core 作为运行时依赖打进单文件 bundle，以便无需调整构建配置

## Implementation Decisions

- **core 零代码改动**：所有需要的零件已在公开面——`buildMemorySpaceTableDigest`、5 个工具工厂（`createQueryRecordsTool`/`createMutateTool`/`createProposalPreviewTool`/`createDropMutateTool`/`createSubmitProposalTool`）、`ProposalState`、`validateProposalOperation`/`validateProposalOperations`/`previewProposal`（经 `@ste-memory/core/memory`）、`runAgentWithTimeout`/`convertAgentMessagesToLlm`（ADR 0024 开放）、prompt 文本（`composeProposalAgentSystemPrompt`/`composeInteractiveProposalAgentSystemPrompt`/`composeTableDigestSummary`）。
- **编排方法不导出**：system 合并 + user/assistant 前缀构造（原 core `systemTextOf`/`toAgentPrefixMessages` 的等价逻辑，约 10 行）由 ST 组装模块自实现——core 只提供文本与零件，不提供装配方法。
- **新建共享组装模块 `src/agent/`**（fill-task 与 query-chat 填写模式共用）：
  - 装配：`ProposalState`（每 run 新建）+ 校验闭包包装 + 5 工具工厂 + `new Agent`（pi-agent-core）；
  - 编排：`ComposedAgentMessage[]` → `{ systemPrompt, prefixMessages }`（system 合并空行分隔、user/assistant 进前缀，ST 自实现）；
  - 守卫：仅"组合后至少一条消息"（抛错），不复制"第一条/最后一条必须 user"；
  - run：`runAgentWithTimeout`（超时/取消语义沿用 core）；结果形状对齐 `ProposalAgentRunResult`，`proposal` 取 `state.frozenProposal`。
- **digest 由 ST 块循环构建**（`buildMemorySpaceTableDigest` 公开函数）：块内构建一次，同时喂消息展开与工具装配（喂组装模块）——组装模块不内置 digest 构建，`ComposedAgentMessage[]` 是唯一消息输入形状；"每 run 一次"由 ST 保证。
- **默认预设路径**：无活动预设时 `composed = composeProposalAgentMessages(digest)`（core 已导出的文本函数，返回单条 system 消息，与预设展开器同形状）——组装模块不需要"默认组合器"特殊分支。
- **fill-task-service 改造**：删除 `createComposeMessages` / `FillTaskPromptFactory` 选项与嵌套；替换为 `createPromptContext`（提交时构造一次，返回**纯数据** `{ preset, snapshot } | undefined`，无方法；内部 = 预设解析 + 世界书扫描 + ST 上下文快照，归属 runtime 装配）；`referencesMsg` 由 service 用 `containsMsgReference(preset)` 推导（preset 存在且含 `{{msg}}` 时 `messages = []`，否则追加块提示词），不重复存储；`composePresetMessages` 纯函数保留（预设 + 块文本 + digest → `ComposedAgentMessage[]`）；块证据、清洗、事务提交、运行日志逻辑不动。
- **query-chat-service 改造**：填写模式改用共享组装模块，`composed = [{ role: "system", text: composeInteractiveProposalAgentSystemPrompt(digest) }]`（同形状），本轮消息列表照旧；查询模式（QueryAgent）不动。
- **行为变化（接受）**：删除"最后一条必须 user"守卫后，assistant 结尾的预设直接进入 run，模型可能在无 user 提示下续编——由 pi/API 自然处理，不报错。
- **构建**：pi-agent-core 从 type-only 依赖变为运行时依赖，esbuild 全量 bundle 自动打入（无 external 配置，无需改动）。
- **文档**：`.scratch/agent-app-assembly/spec.md` 原"st-extension 迁移"Out of Scope 打开，本 spec 取代之。

### 组装模块接口草案（初始形状，实现时允许调整）

以下形状来自讨论与查证，作为实现的**初始草案**——实际代码若发现形状不贴合（如工具装配需要额外依赖、守卫位置更自然、参数命名冲突等），允许按实现需要调整，只要保持决策要点：ST 持有编排权、`ComposedAgentMessage[]` 为唯一消息输入形状、结果对齐 `ProposalAgentRunResult`。

```ts
// src/agent/fill-agent-runner.ts（文件名与位置允许调整）
interface FillAgentRunInput {
  readonly llm: LlmPort;
  readonly reader: MemorySpaceReader;
  readonly ports: MemoryProposalPorts;
  readonly memorySpaceId: MemorySpaceId;
  /** 编排消息（ST 已展开）：system 合并进系统提示词，user/assistant 进前缀 */
  readonly composedMessages: readonly ComposedAgentMessage[];
  /** 本轮消息（块提示词 / 用户对话），可为空（{{msg}} 接管场景） */
  readonly messages: readonly AgentMessage[];
  readonly messageRange: MemoryMessageRange;
  readonly evidence: readonly MemoryEvidence[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentEvent) => void;
}

interface FillAgentRunResult {
  readonly messages: readonly AgentMessage[];
  readonly stopReason: StopReason | undefined;
  readonly errorMessage: string | undefined;
  readonly answer: string;
  readonly proposal: MemoryProposalSubmission | undefined;
}
// 形状对齐 ProposalAgentRunResult；proposal 取 state.frozenProposal
```

## Testing Decisions

- **测试只测外部行为**：不 mock Agent 装配内部步骤（digest 构建/State/工具工厂各自的行为由 core 契约测试锁定），组装模块测试与 service 测试都经 `scriptedStreamFn` 驱动真实 Agent 循环。
- **Seam 1（现有，最高）**：`FillTaskService` / `QueryChatService` 公开方法，经 `createLlm` 注入 scriptedStreamFn——既有测试结构不变（`fill-task-service.test.ts` / `query-chat-service.test.ts`），改造后继续全绿；`createComposeMessages` 注入测试改为新路径断言（system 消息展开进 system prompt 的既有断言保留）。
- **Seam 2（新）**：`src/agent/` 组装模块单测——fixture digest（`memory-space-data` 风格）+ scriptedStreamFn，验证：system 合并/前缀顺序、守卫（组合后为空抛错）、run 结果形状（stopReason/proposal 冻结）。预设展开与 digest 构建属 ST 块循环职责，在 Seam 1 的 service 测试中覆盖（含默认预设路径与 `{{msg}}` 接管场景）。
- **Prior art**：`core/test/agent/proposal-agent.test.ts`（scriptedStreamFn 驱动完整工具循环）、`apps/st-extension/src/fill-tasks/fill-task-service.test.ts`（createLlm 注入 + harness 模式）。

## Out of Scope

- core 代码改动（零改动；仅 spec 文档层面打开迁移范围）
- api 侧（继续使用 core `ProposalAgent`，含交互式填写字符串组合器）
- 查询模式（QueryAgent）改造
- 恢复"第一条/最后一条必须 user"守卫
- 预设模型/编辑器、世界书扫描、recorder（fill-run-log）、清洗规则、云同步、镜像——均不动
- core 导出装配方法/助手（如 `composeSystemPromptAsMessages`、`createProposalToolDeps`）——用户决策：ST 自实现

## Further Notes

- 体积成本：pi-agent-core tree-shake 后约 +227KB raw / 64KB gzip（ADR 0018 实测），打进 ST 单文件 bundle。
- core 的 `agent-run-contract.test.ts`（ADR 0024）继续有效：零件公开面由契约测试锁定，ST 组装建立在其上。
- `FillTaskPromptFactory` 类型删除后，`FillTaskServiceOptions.createComposeMessages` 与 `runtime.ts` 对应装配一并移除。
- 编排规则（system 合并/前缀）在 ST 与 core `ProposalAgent` 各有一份实现——api 侧继续用 core 的实现，ST 用自实现；两处行为对齐由 ST 组装模块测试保障（不追求共享代码，遵守"core 不读 ST 业务"）。
