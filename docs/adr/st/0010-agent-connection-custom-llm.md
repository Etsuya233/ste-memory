# Agent 连接：自定义 LLM 走 ST 同源代理的 reverse_proxy 路径

用户要求表格填写 Agent 与查询 Agent 支持各自的 LLM API 配置（URL/Key/模型），此前两者只能复用 ST 当前 Chat Completion 连接（runtime.ts 的 createStLlmPort）。决定：设置模型引入命名「Agent 连接」池（Base URL + API Key + 模型名），每个 Agent 选择「跟随 ST 当前连接」或某个连接；选中自定义连接时，生成请求仍发往 ST 同源代理 `/api/backends/chat-completions/generate`，但以 `chat_completion_source: "openai"` + `reverse_proxy`（规范化后的 Base URL）+ `proxy_password`（API Key）携带连接信息，由 ST 服务端转发上游。

理由：完全复用现有 StBackendsLlmAdapter 的 SSE 解析、工具调用与 CSRF 机制，无 CORS 依赖；密钥不进 ST secret store，对 ST 主连接零副作用。

## Considered Options

- **custom source + secret_id**：key 存 ST secret store 更安全，但插件写 key 必须调 `/api/secrets/write`，其 writeSecret 会把同桶旧 secret 全部置为非 active、新 key 置为 active——会顶掉用户 ST 主连接 Custom provider 正在用的 key；且前端拿不到已有 secret 的 id，无法引用用户已存连接。拒绝。
- **浏览器直连**：目标服务须开 CORS；key 同样明文；流式/工具调用解析需自建。拒绝。
- **ST server plugin 自建端点**：独立 secret 桶 + 服务端代理最干净，但要求用户额外安装 server 插件，部署复杂度大增。拒绝（未来可选）。

## Consequences

- API Key 以明文存于 extension_settings（浏览器 localStorage），UI 需标注；这是 ST 生态惯例，权衡已接受。
- ST 服务端固定拼 `${base}/chat/completions`，插件发送前需规范化 URL（剥尾部 `/chat/completions` 与斜杠）。
- `include_reasoning` 不会被 ST 转发（仅 OpenRouter 等 source 支持）：自定义连接的思考流为尽力而为——上游发 `reasoning_content` 即解析。
- 「测试连接」与模型列表复用 `/api/backends/chat-completions/status`（支持 reverse_proxy + proxy_password，零 token 成本）。
- 生成参数（temperature/maxTokens/contextWindow 等）第一版仍读 ST 快照，连接只覆盖 URL/Key/模型名。
