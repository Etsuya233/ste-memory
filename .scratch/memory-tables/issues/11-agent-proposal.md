# 11 — 实现 Agent 引擎与 QueryAgent

**Type:** task

**What to build:** 在 core 引入 pi-agent-core 通用 Agent 引擎并跑通：实现只读 `query_records` 工具与 QueryAgent（对记忆空间内容提问的问答 Agent），并定义 LLM 端口类型。本 Ticket 只做 core，不碰 apps/api 与 apps/web：SSE 端点、LLM 配置接入与聊天界面见 11.5；提案生成相关内容见 12。

**Blocked by:** 10 — 保存字段级证据并支持原始聊天对比

**Status:** ready-for-agent

- [ ] `core/src/agent` 模块直接使用 pi-agent-core 类型（`Agent`/`AgentTool`/`AgentMessage`/`Model`/`StreamFn`），不包壳；`core/src/memory` 保持零 pi 依赖（ADR-0018）。
- [ ] 定义 LLM 端口 = `{ streamFn, Model, getApiKey }`（pi 类型，见设计文档）；具体 provider/配置构造由 11.5 的 api 实现，本票不做。
- [ ] `query_records` 工具（本 Ticket 唯一工具）：只读，经应用层查询端口执行；Agent 与工具的交互（schema/结果）全部使用 key；schema 用 TypeBox（op 为 enum、value 为 string|number|boolean|null）；执行器校验启用表/字段 + key↔id 映射，报错带可用 key 列表回喂。结果形状 `{ id, revisionId, display, values }`，剥掉 fieldEvidence/source 等噪音；不指定 fields 时返回全部启用字段；引用字段 v1 裸 id；paging 默认 page 1/pageSize 20（服务层已有 cap 100）。
- [ ] QueryAgent：对记忆空间内容提问的问答 Agent，只使用 `query_records`，无任何写入工具；普通 Agent 循环（模型无 tool_calls 自然停止），每请求一个 Agent 实例，总超时 5 分钟。
- [ ] QueryAgent 提示词 = 基础问答指令 + 启用表/字段摘要（与工具校验共用同一份 `MemorySpaceTableDigest`，run 启动时构建一次）；不含来源消息（提案提示词归 12）。
- [ ] Agent 跑通以 core 级测试为准：脚本化假 streamFn 跑通整循环（工具调用 → 查询结果 → 回答），不依赖真实模型与 HTTP。
- [ ] 不碰 api 与 web 的任何内容：SSE 端点、LLM 配置接入、聊天界面、Token 浏览器保存约束均属 11.5；submit_proposal、提案 DSL、消息范围处理、提案端点属 12。

## Comments

### 2026-08 设计确认（pi-agent-core 引入后，11/11.5 重新拆分）

技术设计详见 `.scratch/memory-tables/11-agent-engine-design.md`。以下为要点；标注「参考」的 pi 细节以实际安装版本为准，不要死磕。

**Agent 引擎**：`@earendil-works/pi-agent-core`（ADR-0018）。`core/src/agent` 直接使用 pi 类型（`Agent`/`AgentTool`/`AgentMessage`/`Model`/`StreamFn`）不包壳；`core/src/memory` 零 pi 依赖。LLM 端口 = `{ streamFn, Model, getApiKey }` 组合；本票只定义端口类型，不实现厂商接入（配置映射、provider 构造见 11.5，参考设计文档 §4）。

**循环语义**：普通 Agent——模型无 tool_calls 自然停止即结束，不设 terminate；每请求一个 Agent 实例；总超时 5 分钟（参考）。安全阀（最大工具轮次、pageSize 硬上限）后续再做；query 服务层已有 pageSize cap 100。

**query_records 工具**：只读，经应用层查询端口执行；schema 用 TypeBox（op 为 enum、value 为 string|number|boolean|null）；executor 做启用表/字段校验 + key↔id 映射，报错带可用 key 列表回喂。结果 `{ id, revisionId, display, values }`（values 用字段 key 键控），剥掉 fieldEvidence/source 等噪音；不指定 fields 返回全部启用字段；引用字段 v1 裸 id（display 解析延期）；paging 默认 page 1/pageSize 20。结果的 `revisionId` 是记录乐观并发版本号，供后续提案 update/delete 的 `expectedRevisionId` 使用（见 12）。

**QueryAgent**：问答 Agent，只挂 query_records。`MemorySpaceTableDigest`（启用表/字段摘要）在 run 启动时构建一次，prompt 组合与工具校验共用。

**测试**：core 级脚本化假 streamFn 跑通整循环（工具调用 → 查询结果 → 回答）；api/web 测试归 11.5。

### 拆分历史

- SSE 流式端点与 LLM 配置接入（env 读取、provider 构造、配置合并）从本票移出归入 11.5（api）；Web 聊天界面、LLM 配置表单与 Token 浏览器保存约束归 11.5（web）。
- 提案生成相关（submit_proposal、提案 DSL、消息范围处理、提案端点、提案提示词）归 12；原提案 Web 界面内容（范围选择、提案面板、确认提交）随提案流顺延到 12 相关票。
