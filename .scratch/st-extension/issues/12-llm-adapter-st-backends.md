# 12 — LLM 适配器（ST backends 同源代理）

**What to build:** Agent 的 streamFn 实现：fetch ST 同源代理 `POST /api/backends/chat-completions/generate`（getRequestHeaders() 的 CSRF 头、ST 特有请求字段、tools/tool_choice 透传、SSE 解析转 pi 事件协议）；模型与密钥复用 ST 当前配置；错误处理（401/429/断流/超时）；未文档化契约集中隔离在本适配器。

**Blocked by:** 02 — 插件工程骨架与构建链

**Status:** ready-for-agent

- [ ] 请求形状正确（ST 特有字段齐全），mock fetch 测试通过
- [ ] SSE 流转为 pi 事件流；tools 透传可用
- [ ] 错误路径（鉴权失败、限流、断流）有清晰处理
- [ ] 手动冒烟：真实 ST 中调用一次生成成功
