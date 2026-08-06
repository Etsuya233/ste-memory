# 16 — 填表任务实时运行输出（Agent 日志流）

**Type:** task

**Status:** ready-for-agent

**Blocked by:** 13, 14

## Problem Statement

填表任务（13/14）是服务端自持的后台循环：`FillTaskService.#runTask` 逐块调用 `ProposalAgent.run`，每块一次 LLM 调用。但 `#processBlock` 调用 `agent.run(input)` 时未传 `RunHooks`，pi `AgentEvent`（思考增量、工具调用参数/结果）被直接丢弃。网页端只能轮询 `GET /memory-spaces/:spaceId/fill-tasks/active`，看到状态与 `processedCount`，看不到"当前 Agent 在做什么"——是否在查表、查了哪些表/字段、条件是否正确、每块产生了什么提案。而 QueryAgent 聊天（11.5）已经实现了同样的实时展示：`agent.run(input, { onEvent })` → `translateAgentEvent` → SSE 流式推送，web 侧实时渲染思考与工具调用。填表任务缺的正是这一条链路，且其「任务先于订阅者存在、跨请求存活」的特性要求额外的服务端缓冲与订阅机制。

## Solution

把填表循环的 Agent 输出接上与聊天同一套事件链路，并为「任务进行中才订阅」的场景提供服务端事件总线：

1. **事件发出**：`#processBlock` 中 `agent.run(input, { onEvent })`，复用 11.5 的 `translateAgentEvent` 把 pi 事件翻译为应用事件；循环层在每块前后发出块事件（范围、结果摘要），在状态转换安全点发出任务状态事件。
2. **共享事件类型**：应用层事件类型与翻译函数从 `application/chat/` 上移到共享位置，聊天与填表共用同一实现；事件形状保持 11.5 已定契约（不带 runId，`seq` 由总线附加）。
3. **per-run 事件总线**：`FillTaskService` 内维护按 `runId` 的订阅者列表 + 有界环形缓冲（**每 run 最近 1000 条**），每条事件带递增 `seq`；新订阅者先重放缓冲再收实时事件；断线重连经 `Last-Event-ID` 续传；任务终态发出终态事件并（无订阅者时）清理缓冲；emit 不阻塞任务循环。
4. **SSE 端点**：`GET /memory-spaces/:spaceId/fill-tasks/:runId/events` 订阅事件流；把 chat 路由的 `streamChat`（hijack + CORS + close 监听）抽成通用 `streamSse` 复用。**语义差异**：客户端断开只退订，绝不中止任务（中止仍走 `POST .../cancel`）；任务已终态时订阅则回放缓冲 + 终态事件后正常关闭，不挂空流。
5. **Web 实时日志**：填表面板新增运行日志区，复用 chat 的 fetch + `ReadableStream` SSE 消费模式；思考/工具调用的渲染从 `QueryChatPanel` 抽成共享组件；保留 active 轮询作为断线兜底与表单状态来源。

## User Stories

1. 作为用户，填表任务运行中，我想在填表面板实时看到当前 Agent 的运行输出（当前块范围、思考增量、工具调用参数/结果、每块结果摘要），以便判断填表是否符合预期——与调试 QueryAgent 聊天（11.5）的体验一致。
2. 作为用户，任务进行中才打开页面或切回填表面板时，我想看到已发生运行输出的回放（最近 1000 条）而不是空白，以便了解任务从何开始、当前进展。
3. 作为用户，网络抖动导致流断开后，我想从断点自动续传（缓冲范围内不丢不重），而不是重新打开页面。
4. 作为用户，关闭页面或断开连接时，任务应在后台继续运行，不应被误中止；中止仍通过面板上的中止按钮生效。
5. 作为维护者，填表与聊天的 Agent 事件翻译和渲染应共用同一套实现，避免两套调试 UI 行为漂移。
6. 作为维护者，事件流的内存占用应有界，慢订阅者或长时间任务不应拖垮服务或阻塞任务循环。

## Structural Map

```
apps/api/src
├── application/
│   ├── agent-events.ts                  # 新增：AgentRunEvent 类型 + translateAgentEvent
│   │                                    #   + terminalAgentRunEvent + 块/状态事件构造
│   │                                    #   （自 application/chat/chat-events.ts 上移，类型更名）
│   ├── chat/
│   │   ├── chat-events.ts               # 删除（上移后无内容，import 改指 agent-events.ts）
│   │   ├── chat-manager.ts              # import 更新；行为不变
│   │   └── llm-config.ts                # 不变
│   ├── fill-tasks/
│   │   ├── fill-task-service.ts         # 改：#processBlock 挂 onEvent；循环发 block/task_status 事件
│   │   │                                #   ；实现 #emit/#subscribe/#buffer；终态清理
│   │   └── fill-task-block.ts           # 不变
│   └── ports/
│       ├── fill-task-manager.ts         # 不变（控制端点契约不动）
│       └── fill-task-events.ts          # 新增：FillTaskEventBus 端口（subscribe 返回退订函数）
├── adapters/inbound/http/
│   ├── sse.ts                           # 新增：通用 streamSse（自 chat/routes.ts 的 streamChat 抽出）
│   ├── chat/routes.ts                   # 改用 streamSse；行为不变
│   └── fill-tasks/routes.ts             # 改：新增 GET /memory-spaces/:spaceId/fill-tasks/:runId/events
apps/web/src
├── api/fill-tasks.ts                    # 改：新增订阅函数（fetch + ReadableStream，模式同 api/chat.ts）
├── fill-task-events-state.ts            # 新增：纯函数状态（按 seq 追加/去重/修剪、与轮询状态合并）
├── components/
│   ├── AgentActivityView.tsx            # 新增：自 QueryChatPanel 抽出（思考折叠、工具参数/结果展开、错误高亮）
│   ├── QueryChatPanel.tsx               # 改：改用共享组件；行为不变
│   └── FillTaskPanel.tsx                # 改：新增实时运行日志区；保留轮询
```

依赖方向不变：web → api HTTP；HTTP adapter → application 端口；`FillTaskService` → core `ProposalAgent`（`RunHooks` 已存在，无需 core 改动）。禁止绕过：SSE 端点只读事件总线，不直接触碰任务行状态；客户端断开不得触发任务状态变化。

**事件形状**（应用层 `AgentRunEvent`，`seq` 由总线附加，SSE data 为 `{ seq, event }`）：

```ts
type AgentRunEvent =
  // 聊天与填表共用（透传 11.5 形状）
  | { type: "thinking_delta"; text: string }
  | { type: "message_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; name: string; result: unknown; isError: boolean }
  // 填表循环专用
  | { type: "block_start"; from: number; to: number }
  | { type: "block_done"; from: number; to: number; emptyProposal: boolean; changedRecords: number }
  | { type: "task_status"; status: FillTaskStatus; errorMessage: string | null }
  // 聊天终态（11.5 已定契约，形状不变）
  | { type: "done"; stopReason: string; errorMessage: string | null }
  | { type: "error"; message: string };
```

- 联合类型为完整超集：chat 只产生 agent + `done`/`error` 子集，fill-task 只产生 agent + `block_*`/`task_status` 子集；两个生产方各用各的子集，共享翻译与类型。
- 填表终态（succeeded / failed / cancelled）经 `task_status` 表达后服务端关闭流，无独立 done 事件。
- 块结果只发摘要（空提案 / 变更记录数），不流式发送完整提案明细。

## Acceptance Criteria

1. 填表任务运行中，填表面板实时显示：当前块范围（`block_start`）、思考增量、工具调用参数与结果（可展开/收起、错误高亮）、每块结果摘要（`block_done`：空提案或变更条数）、任务状态与终态；全程无需刷新页面。
2. 任务进行中才订阅的客户端收到「最近 1000 条缓冲回放 + 之后实时事件」；`Last-Event-ID` 重连在缓冲范围内从断点续传，不丢不重。
3. 客户端断开订阅后任务继续运行，不被中止；中止仍经 `POST .../cancel` 在安全点生效（行为与 14 一致）。
4. 任务终态时流发出对应 `task_status` 后正常关闭；终态后才订阅的客户端收到回放 + 终态事件后关闭，不挂空流。
5. `runId` 不存在或不属于该空间 → 404（与既有 fill-task 端点一致）；缓冲有界（per-run ≤ 1000 条），tool 载荷超限截断并标记，任务终态且无订阅者后缓冲被清理。
6. 慢订阅者/写失败不阻塞任务循环：socket 写失败静默忽略并记日志，循环照常推进。
7. 聊天（11.5）的事件形状、错误语义与「客户端断开即中止 run」行为保持不变；既有 fill-task 轮询与控制端点契约保持不变。
8. 事件翻译与渲染与聊天共用同一实现（`translateAgentEvent` 单一来源、`AgentActivityView` 共享组件），无复制粘贴的平行实现。
9. 新增测试覆盖应用层总线与 HTTP SSE 全流程（见 Testing Decisions）；全仓测试通过，typecheck / lint / prettier 干净。

## Implementation Decisions

- **共享事件类型上移**：`ChatEvent` 更名 `AgentRunEvent` 并移至 `application/agent-events.ts`；`chat/chat-events.ts` 删除，chat-manager / chat 路由 / 相关测试的 import 更新。事件不带 runId（SSE 端点路径已限定），chat 线上契约零变化；`seq` 由总线附加，不进入应用事件本体。
- **块/状态事件由循环发出**：`#processBlock` 入口发 `block_start`、出口发 `block_done`（含 `emptyProposal` / `changedRecords`，空提案视为成功）；状态转换（paused / cancelled / succeeded / failed / 恢复 running）在安全点应用时发 `task_status`。`interrupted`（API 重启）无运行循环，不产生事件，客户端经既有轮询发现。
- **事件总线为内存态**：`FillTaskService` 内部持有 per-run 环形缓冲与订阅者集合；端口 `FillTaskEventBus` 只暴露 `subscribe(runId, listener): () => void`，HTTP 层不依赖具体实现。缓冲上限 **1000 条**（用户已确认）。
- **背压策略**：订阅者回调同步写 socket，写失败 try/catch 忽略（与 chat 现状一致）；emit 不 await 订阅者，任务循环不被慢客户端拖慢。
- **tool 载荷截断**：`tool_start.args` / `tool_result.result` 序列化超过 16 000 字符时截断为前缀 + `truncated: true`（截断发生在入缓冲前，测试锁定该行为）。
- **重连续传**：每条 SSE 事件 `id: <seq>`；客户端断开重连时带 `Last-Event-ID`，服务端从缓冲中 `seq > lastEventId` 处重放；`lastEventId` 超出缓冲范围（太旧）时回放全部缓冲。
- **订阅与终态**：终态后订阅 → 回放缓冲 + 当前终态 `task_status` 后关闭；订阅期间任务终态 → 发 `task_status` 后关闭；缓冲在「终态且订阅者为 0」时清理。
- **取消语义差异（与聊天相反）**：填表事件流是旁观者，不是 run 的所有者；断开只退订。这是与 11.5 最需要区分的一点，实现与测试都要显式覆盖。

## Testing Decisions

- **最高测试缝**：HTTP 层完整 SSE 流（`apps/api/test/fill-task-events.test.ts` 新增，模式对齐 `apps/api/test/chat.test.ts`：`server.inject` + `scriptedStreamFn` 驱动 ProposalAgent + 解析 `data:` 行断言事件序列）。
- **应用层**：`fill-task-events` 总线单测（或经 service 测试覆盖）：缓冲上限 1000 条（第 1001 条挤掉最旧）、晚订阅回放顺序、`Last-Event-ID` 续传（含越界回退全量）、多订阅者扇出、终态后订阅收终态并关闭、终态无订阅者后缓冲清理、emit 不因订阅者抛错而中断循环。
- **断开不中止**：订阅后关闭连接，任务循环继续推进（断言后续 `block_done` 仍产生、任务最终 succeeded）——与 chat 的「断开中止 run」测试（chat.test.ts 中 abort 断言）形成对照。
- **HTTP 端点**：404（runId 不存在 / 不属于该空间）；任务进行中订阅收到当前块事件；终态后订阅收到回放 + 终态；tool 载荷截断标记；SSE 头（content-type、CORS）与 chat 一致。
- **web**：`fill-task-events-state.test.ts`（按 seq 追加/去重/乱序、容量修剪、与轮询 `active` 合并：终态由流到达时优先、轮询兜底）。
- 既有测试（chat.test.ts / fill-task.test.ts / fill-task-lifecycle.test.ts）保持绿色，证明 chat 契约与填表控制端点未回归。

## Out of Scope

- 暂停/恢复/中止的控制逻辑与状态机（14 已完成，仅需在循环安全点顺带发事件）。
- 完整提案明细的流式展示（只发块结果摘要）。
- 事件持久化/重启后回放（总线为内存态；重启后 `interrupted` 由既有轮询呈现）。
- 多用户、鉴权与跨进程事件分发（本地单用户，ADR 0017）。
- QueryChatPanel 其余 UI（输入框、历史、LLM 配置表单）不变。

## Assumptions and Open Questions

- 缓冲上限 1000 条为每 run 服务端内存上限（用户已确认）；截断阈值 16 000 字符、`Last-Event-ID` 越界回退全量等数值细节在测试中锁定后可微调。
- ProposalAgent 以思考与工具调用为主要可见输出，`message_delta` 可能较少；UI 对四种 agent 事件统一渲染，不做特殊空态处理。
- 事件不带 runId（端点路径已限定），聊天线上契约零变化——若未来需要跨 run 聚合（如全局活动流），再引入 runId 字段，不阻塞本票。
- 无关键开放问题。
