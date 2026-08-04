# 11 — 为选定消息范围生成 Agent 提案

**Type:** task

**What to build:** 接入 OpenAI-Compatible Tool Calling，为用户选定的一段 1-based 包含端点消息范围生成一个 Agent 提案。Agent 读取启用的表和字段 Prompt，通过只读查询工具分析来源，但本 Ticket 不直接写入正式表。

**Blocked by:** 10 — 保存字段级证据并支持原始聊天对比

**Status:** ready-for-agent

> Web 界面部分（LLM 配置表单、范围选择、提案展示）已拆分到 11.5。

- [ ] ~~页面提供 Base URL、API Key、model 配置；空值时按字段回退服务端环境变量。~~（移至 11.5）
- [ ] ~~API Key 只保留在当前页面内存中，不写数据库或 localStorage；非敏感配置可保存在浏览器。~~（移至 11.5）
- [ ] HTTP Adapter 将选定范围作为一个处理块传入 Application，范围包含起止消息且不会自动处理整段聊天。
- [ ] 当前版本不处理 max_token、前文尾部补齐或 ST Prompt 注入。
- [ ] 一个 Agent 覆盖该空间内所有启用的表和字段，组合默认/用户 Prompt 与来源消息。
- [ ] Agent 只能调用只读 `query_records`，不得绕过 Application 直接访问数据库。
- [ ] 输出是结构化可审阅提案，包含创建、更新、删除意图和每个字段的证据定位。

## Comments

### 2026-08 设计讨论确认（pi-agent-core 引入后）

**Agent 引擎**：采用 `@earendil-works/pi-agent-core`（ADR-0018）。新模块 `core/src/agent/` 直接使用 pi 类型（`Agent`/`AgentTool`/`AgentMessage`/`Model`/`StreamFn`）不包壳；`core/src/memory` 保持零 pi 依赖。LLM 端口 = `{ streamFn, Model, getApiKey }` 组合。

**OpenAI-Compatible 配置映射**：`createProvider` + `openAICompletionsApi()` 指向运行时 Base URL；API Key 经 `Agent.getApiKey` 钩子按请求传入（只存本次请求内存，不落库/落盘/打日志）；env 回退用 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`，逐字段合并 `web ?? env`。streamFn = `models.streamSimple.bind(models)`。max_tokens 不设上限（一般 LLM 参数可透传）；「不处理 max_token」仅指不做按 token 切分处理块。

**循环语义**：普通 Agent——submit_proposal 是普通工具，不设 terminate；模型无 tool_calls 自然停止即结束；每请求一个 Agent 实例；总超时 5 分钟（AbortController → `agent.abort()`）。

**工具（本次只实现两个）**：
- `query_records`：只读，经应用层查询端口执行，模型世界全用 key；schema 用 TypeBox（op 为 enum、value 为 string|number|boolean|null）；executor 做启用表/字段校验 + key↔id 映射，报错带可用 key 列表回喂。结果形状 `{ id, revisionId, display, values }`，剥掉 fieldEvidence/source 等噪音；不指定 fields 时返回全部启用字段；引用字段 v1 裸 id（display 解析延期）；paging 默认 page 1/pageSize 20，服务层 cap 100；只接受启用表/字段。
- `submit_proposal`：参数即提案 DSL；执行时轻量结构校验（不查库：op 合法、必需字段齐、fieldEvidence 的 source_id 落在当前处理块内），失败 throw（pi 转 isError 回喂自愈）；表/字段存在性、类型、必填、引用、revision 校验归 12。

**提案 DSL 形状**：
```jsonc
create: { type, table, tempId, patch, fieldEvidence? }
update: { type, table, recordId, expectedRevisionId, patch, fieldEvidence? }
delete: { type, table, recordId, expectedRevisionId }
fieldEvidence: { [fieldKey]: [{ source_type, source_id }] }  // 仅引用处理块内消息
```
映射：query_records 结果的 `id` → 操作 `recordId`；结果的 `revisionId` → `expectedRevisionId`（提交时 `WHERE revision_id = expected` 做乐观锁，不匹配整批失败）。create 无 revision。

**提案提取**：agent_end 后取最后一次成功 submit_proposal 的参数；`CustomAgentMessages` 声明合并延后。

**端到端**：同步 `POST /api/memory-spaces/:id/proposals`（range + 可选 LLM 配置），5 分钟超时。Web 界面部分见 11.5。

**优先级**：先 Agent 主流程 + query_records + api 端点，后 Web 实验界面。

**测试**：agent 模块用脚本化假 streamFn 单测整循环；api 集成测试 stub provider；web 断言 apiKey 不写 localStorage。

### 11.5 拆分

Web 界面部分拆为独立 Ticket `11.5-web-proposal-ui.md`（Blocked by 11）：LLM 配置表单、ChatViewer 1-based 闭区间范围选择、生成按钮与结构化提案面板。本 Ticket 专注后端：HTTP Adapter 端点（逐字段 env 回退合并、API Key 仅请求内存不落盘）、`core/src/agent` 模块、provider 构造与提案生成。
