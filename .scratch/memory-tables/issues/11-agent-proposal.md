# 11 — 实现 Agent 引擎与 QueryAgent

**Type:** task

**What to build:** 在 core 引入 pi-agent-core 通用 Agent 引擎并跑通：实现只读 `query_records` 工具与 QueryAgent（对记忆空间内容提问的问答 Agent），并提供 LLM 配置接入与可流式调用的后端聊天端点。本 Ticket 不做提案生成：submit_proposal 工具、提案 DSL、消息范围处理与提案端点留到 12。

**Blocked by:** 10 — 保存字段级证据并支持原始聊天对比

**Status:** ready-for-agent

- [ ] `core/src/agent` 模块直接使用 pi-agent-core 类型（`Agent`/`AgentTool`/`AgentMessage`/`Model`/`StreamFn`），不包壳；`core/src/memory` 保持零 pi 依赖（ADR-0018）。
- [ ] `query_records` 工具（本 Ticket 唯一工具）：只读，经应用层查询端口执行；模型世界全用 key；schema 用 TypeBox（op 为 enum、value 为 string|number|boolean|null）；执行器校验启用表/字段 + key↔id 映射，报错带可用 key 列表回喂。结果形状 `{ id, revisionId, display, values }`，剥掉 fieldEvidence/source 等噪音；不指定 fields 时返回全部启用字段；引用字段 v1 裸 id；paging 默认 page 1/pageSize 20（服务层已有 cap 100）。
- [ ] QueryAgent：对记忆空间内容提问的问答 Agent，只使用 `query_records`，无任何写入工具；普通 Agent 循环（模型无 tool_calls 自然停止），每请求一个 Agent 实例，总超时 5 分钟（AbortController → `agent.abort()`）。
- [ ] QueryAgent 提示词 = 基础问答指令 + 启用表/字段摘要（与工具校验共用同一份 digest，run 启动时构建一次）；不含来源消息（提案提示词归 12）。
- [ ] 后端聊天端点：对本空间提问，SSE 流式返回，实时推送思考、工具调用参数/结果与回答增量；支持取消。
- [ ] LLM 配置：`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` 环境变量，网页配置逐字段覆盖、空值回退；API Key 仅本次请求内存，不落库/落盘/打日志；`createProvider` + `openAICompletionsApi()` 指向运行时 Base URL，`getApiKey` 钩子按请求传 key；streamFn = `models.streamSimple.bind(models)`。
- [ ] 不做：submit_proposal、提案 DSL、消息范围处理、提案端点与预览（全部归 12 及后续）。

## Comments

### 2026-08 设计确认（pi-agent-core 引入后，11/11.5 重新拆分）

**Agent 引擎**：`@earendil-works/pi-agent-core`（ADR-0018）。`core/src/agent` 直接使用 pi 类型（`Agent`/`AgentTool`/`AgentMessage`/`Model`/`StreamFn`）不包壳；`core/src/memory` 保持零 pi 依赖。LLM 端口 = `{ streamFn, Model, getApiKey }` 组合。

**配置映射**：`createProvider` + `openAICompletionsApi()` 指向运行时 Base URL；API Key 经 `Agent.getApiKey` 钩子按请求传入（只存本次请求内存，不落库/落盘/打日志）；env 回退用 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`，逐字段合并 `web ?? env`。streamFn = `models.streamSimple.bind(models)`。max_tokens 不设上限（一般 LLM 参数可透传）。

**循环语义**：普通 Agent——模型无 tool_calls 自然停止即结束，不设 terminate；每请求一个 Agent 实例；总超时 5 分钟。安全阀（最大工具轮次、pageSize 硬上限）后续再做；query 服务层已有 pageSize cap 100。

**query_records 工具**：只读，经应用层查询端口执行；schema 用 TypeBox（op 为 enum、value 为 string|number|boolean|null）；executor 做启用表/字段校验 + key↔id 映射，报错带可用 key 列表回喂。结果 `{ id, revisionId, display, values }`（values 用字段 key 键控），剥掉 fieldEvidence/source 等噪音；不指定 fields 返回全部启用字段；引用字段 v1 裸 id（display 解析延期）；paging 默认 page 1/pageSize 20。结果的 `revisionId` 是记录乐观并发版本号，供后续提案 update/delete 的 `expectedRevisionId` 使用（见 12）。

**QueryAgent**：问答 Agent，只挂 query_records。digest（启用表/字段）在 run 启动时构建一次，prompt 组合与工具校验共用。流式端点把 pi 事件（turn_start / message_update / tool_execution_* / agent_end）映射为 SSE 事件，供 11.5 前端实时展示思考与工具调用。

**测试**：agent 模块用脚本化假 streamFn 单测整循环（工具调用 → 查询结果 → 回答）；api 集成测试 stub provider 验证流式事件；web 断言 apiKey 不写 localStorage。

### 拆分历史

- 提案生成相关（submit_proposal、提案 DSL、消息范围处理、提案端点、提案提示词）移出本 Ticket 归入 12；原 11.5 的 Web 提案界面内容（范围选择、提案面板、确认提交）随提案流顺延到 12 相关票。
