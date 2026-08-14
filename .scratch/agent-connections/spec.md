# Agent 连接：为填表 Agent 与查询 Agent 提供自定义 LLM API

Status: ready-for-agent

## Problem Statement

表格填写 Agent 和查询 Agent 目前强制复用 ST 当前 Chat Completion 连接（`createStLlmPort`，runtime.ts 任务开始时读一次快照）。用户希望两个 Agent 各自使用不同的模型服务（例如填表用本地 vLLM、问答用云端 DeepSeek），但插件没有任何 per-agent 的 API 覆盖能力；用户只能手动切换 ST 全局 API 连接（会连带影响 ST 主模型），或放弃差异化。

## Solution

插件设置面板新增「Agent API 连接」区块：用户可以创建若干命名的「Agent 连接」（Base URL + API Key + 模型名），并为表格填写 Agent、查询 Agent 各自选择「跟随 ST 当前连接」或某个 Agent 连接。选中自定义连接后，该 Agent 的生成请求仍走 ST 同源代理 `/api/backends/chat-completions/generate`（无 CORS、复用现有 SSE/工具调用/CSRF 适配器），以 `chat_completion_source: "openai"` + `reverse_proxy`（规范化后的 Base URL）+ `proxy_password`（API Key）携带连接信息，由 ST 服务端转发上游（ADR 0010）。API Key 以明文存于插件设置（浏览器 localStorage），UI 明确标注该权衡。生成参数（temperature/maxTokens/contextWindow 等）第一版仍读 ST 当前配置快照，连接只覆盖「请求发往哪里、用什么模型」。未配置任何 Agent 连接时，两个 Agent 行为与现状完全一致。

## User Stories

**连接管理**

1. 作为用户，我想在设置面板的「Agent 连接」区块创建命名连接（名称 / Base URL / API Key / 模型名），以便为 Agent 指定自定义模型服务
2. 作为用户，我想编辑已有连接的任一字段，以便修正 URL、轮换密钥或换模型
3. 作为用户，我想删除不再使用的连接，以便保持配置整洁
4. 作为用户，删除连接时若某个 Agent 正选中它，该 Agent 自动回退为「跟随 ST 当前连接」，以便不出现悬空引用
5. 作为用户，我想在连接列表看到已配置的 API Key 状态（已配置/未配置，不展示密钥值），以便确认配置而不泄露密钥
6. 作为用户，我想为无鉴权的本地服务（如 Ollama/vLLM）创建不填 Key 的连接，以便本地模型直接可用
7. 作为用户，我粘贴带完整 `/chat/completions` 结尾的地址也能正常工作（插件发送前规范化，剥尾部路径与斜杠），以便不用记忆 URL 形态规则
8. 作为用户，我在配置界面看到「密钥以明文存于浏览器本地」的提示，以便知情使用

**Agent 选择与默认行为**

9. 作为用户，我想为表格填写 Agent 选择「跟随 ST 当前连接」或某个 Agent 连接，以便控制填表任务的模型
10. 作为用户，我想为查询 Agent 选择「跟随 ST 当前连接」或某个 Agent 连接，以便控制问答面板的模型
11. 作为用户，两个 Agent 可以共用同一个连接，以便 key 只配置一次
12. 作为用户，两个 Agent 可以使用不同连接，以便按任务类型分流模型
13. 作为用户，未配置任何 Agent 连接时插件行为与旧版完全一致（跟随 ST 当前连接），以便默认零变化
14. 作为用户，生成参数（温度/输出上限/上下文预算）继续沿用 ST 当前配置快照，以便自定义连接不引入第二套参数心智负担

**测试与模型选择**

15. 作为用户，我想点「测试连接」按钮验证 URL 与 Key 是否可用，以便保存前确认配置有效
16. 作为用户，「测试连接」成功时可以拉取模型列表并填充右侧 Select 下拉，以便不用手抄模型名
17. 作为用户，模型下拉按字典序排序展示，以便快速定位
18. 作为用户，我仍可以手写输入模型名（下拉之外的自由文本），以便服务不提供模型列表或列表不全时可用
19. 作为用户，「测试连接」失败时看到完整的原始错误（401/404/连接拒绝等，不吞信息），以便准确排查配置问题

**运行行为**

20. 作为用户，选中 Agent 连接的填表任务把生成请求发往该连接的上游服务，以便任务模型差异化生效
21. 作为用户，选中 Agent 连接的问答面板把生成请求发往该连接的上游服务，以便问答模型差异化生效
22. 作为用户，自定义连接出错时错误消息带连接名前缀并保留原始上游错误（如「Agent 连接 [DeepSeek 主用]：ST 代理请求失败（401）：Invalid API key」），以便快速定位是哪个连接、什么原因
23. 作为用户，自定义连接失败时任务硬失败且不自动回退 ST 当前连接，以便不被静默降级掩盖配置错误
24. 作为用户，配置变更在任务/对话开始时快照生效，以便行为可预期（与现有 ST 快照语义一致）
25. 作为用户，问答面板的自定义连接尽力而为支持思考流（上游返回 reasoning_content 即解析展示），以便不因连接差异丢失思考内容

## Implementation Decisions

1. **设置形状**：`PluginSettings` 新增 `agentConnections: AgentConnection[]`（`{ id, name, baseUrl, apiKey, model }`）与 `fillTaskConnectionId?: string`、`queryChatConnectionId?: string`（undefined = 跟随 ST 当前连接）。`mergeSettings` 自动补默认（空数组 + undefined），旧设置零迁移。
2. **传输路径（ADR 0010）**：自定义连接请求走 ST 同源代理，`chat_completion_source: "openai"` + `reverse_proxy`（规范化 Base URL）+ `proxy_password`（API Key）；ST 服务端拼 `${base}/chat/completions` 并透传 tools/tool_choice。拒绝的候选：custom source + secret_id（writeSecret 会顶掉 ST 主连接 Custom 的 active key）、浏览器直连（CORS + 自建流式解析）、ST server plugin（部署复杂度）。
3. **URL 规范化**：发送前剥掉尾部 `/chat/completions` 与尾部斜杠；纯函数实现，可单测。
4. **适配器扩展**：`StBackendsModel` 增加可选 `reverseProxy`/`proxyPassword`；`buildStGenerateBody` 存在时写入 body；`StBackendsLlmAdapterOptions` 增加可选 `label`（连接名），所有错误消息统一前缀 `Agent 连接 [名称]：`，上游原始 message 原样保留（不隐藏原始报错）。
5. **端口工厂**：新增 `createAgentConnectionLlmPort(connection, getContext)`：ST 快照参数（温度/预算）+ 连接覆盖模型名/URL/Key；`createStLlmPort` 保持原样不动。core `LlmPort` 接口零改动。
6. **运行时分流**：`createLlm`（填表）与 `createQueryChatLlm`（问答，含 includeReasoning: true）按设置解析连接：命中 → 自定义端口；未命中 → 原路径。任务开始时解析一次（快照语义）。
7. **协议范围**：仅 OpenAI 兼容 chat/completions（流式 + function calling，两个 Agent 的工具调用硬需求全覆盖）。`include_reasoning` 不会被 ST 转发（仅 OpenRouter 等 source 支持），思考流为尽力而为：适配器在 includeReasoning 开启时解析上游 `delta.reasoning_content`。
8. **测试/拉取模型**：复用 `POST /api/backends/chat-completions/status`（支持 reverse_proxy + proxy_password，零 token 成本）：测试连接 = 调 status 验证 URL/Key；成功同时返回模型列表填充 Select；失败展示原始错误。
9. **UI**：设置 Tab 新增「Agent 连接」区块：连接卡片列表（新建/编辑/删除，key 掩码）+ 表单（名称 / Base URL / API Key / 模型 = 手写文本框 + 右侧 Select 下拉，字典序）；「测试连接」按钮；下方两个 Agent 选择器（跟随 ST 当前连接 / 各连接）。

## Testing Decisions

- **好测试的标准**：只测外部行为与纯逻辑，不测实现细节；所有决策规则（CRUD、回退、规范化、排序、请求体形状、错误格式）都在纯函数 seam 断言，UI 组件只做「模型 → DOM」投影与事件接线。
- **新增 seam（纯逻辑）**：`settings/agent-connections.ts` 纯函数模块——连接 CRUD、Agent→连接解析、删除回退「跟随 ST」、URL 规范化、模型字典序排序、/status 测试请求体构造。
- **扩展现有 seam**：
  - `st-backends-request.test.ts`：reverse_proxy/proxy_password 进请求体的形状断言；
  - `st-backends-llm.test.ts`：错误前缀 + 原始错误保留（fetch 注入既有先例）；
  - `runtime.test.ts`：createLlm/createQueryChatLlm 分流（有/无连接 → 正确端口）；
  - UI 组件测试：连接管理器表单交互。
- **先例**：`agent-presets/preset-model.test.ts`（纯 CRUD seam 单测）、`agent-preset-manager.test.tsx`（表单组件测试）、`st-backends-llm.test.ts`（fetch 注入适配器测试）、`st-backends-request.test.ts`（请求体纯函数测试）。
- **不新增 seam**：core 零改动（LlmPort 接口不变）；面板状态机不动。

## Out of Scope

- 生成参数（temperature/maxTokens/contextWindow）的 per-连接覆盖——第一版沿用 ST 快照
- 自定义请求头（custom_include_headers 等 ST custom source 专属能力）
- 原生 Anthropic / Gemini 等非 OpenAI 兼容协议
- per-记忆空间 / per-对话的连接粒度
- ST secret store 集成（key 明文存插件设置，ADR 0010 权衡）
- 失败自动回退 ST 当前连接（硬失败）

## Further Notes

- 词汇表：`apps/st-extension/CONTEXT.md` 已记「Agent 连接」词条（Avoid: 自定义 API、LLM 配置、API 连接）。
- ADR：`apps/st-extension/docs/adr/0010-agent-connection-custom-llm.md`（传输路径决策 + 被拒候选 + 后果）。
- 密钥明文权衡：ST 生态惯例（多数扩展如此）；UI 明示；如未来需要更强安全可评估 server plugin 路径。
- 与 ST 1.18.0 契约对齐：generate/status 端点的 reverse_proxy + proxy_password 行为已核实（chat-completions.js）。
- 实现时可拆 ticket：01 设置模型 + 纯逻辑 seam、02 适配器/请求体/端口工厂、03 运行时分流、04 UI 区块、05 测试收尾；每个 ticket 独立可验收。
