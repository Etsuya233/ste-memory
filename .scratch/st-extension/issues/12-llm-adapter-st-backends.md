# 12 — LLM 适配器（ST backends 同源代理）

**What to build:** Agent 的 streamFn 实现：fetch ST 同源代理 `POST /api/backends/chat-completions/generate`（getRequestHeaders() 的 CSRF 头、ST 特有请求字段、tools/tool_choice 透传、SSE 解析转 pi 事件协议）；模型与密钥复用 ST 当前配置；错误处理（401/429/断流/超时）；未文档化契约集中隔离在本适配器。

**Blocked by:** 02 — 插件工程骨架与构建链

**Status:** resolved

- [x] 请求形状正确（ST 特有字段齐全），mock fetch 测试通过
- [x] SSE 流转为 pi 事件流；tools 透传可用
- [x] 错误路径（鉴权失败、限流、断流）有清晰处理
- [ ] 手动冒烟：真实 ST 中调用一次生成成功（脚本已备：docs/playwright-st-extension/verify-llm-adapter.mjs，待真实 ST 环境执行）

## Answer

工作树提交（8 文件 + 5 个新文件；st-extension 344 例全绿 + Agent 交叉验证，全仓 663/663 绿，typecheck/prettier/eslint 全绿，build 产物无 node: 引用）。

- **`src/llm/st-completion-settings.ts`**：读 ST 当前配置（`getContext().chatCompletionSettings` + `getChatCompletionModel`，st-context.js 已核实）→ `StBackendsModel`（pi Model + `stSource`）。**模型与密钥复用 ST 当前配置**：模型名走 ST 官方映射，密钥在 ST 服务端 secret store，插件永远不见 key（CUSTOM 源无 key 校验、其余源缺 key 服务端 400）。source 随模型走 → streamFn 保持 pi 契约纯函数形状。
- **`src/llm/st-backends-request.ts`**：generate 请求体构造（未文档化契约集中隔离，注释带 ST 源码行号）：ST 特有字段 `type: "normal"` / `chat_completion_source` / `include_reasoning: false` / `stream: true` + 生成参数（ST 配置，`options.temperature/maxTokens` 显式覆盖优先）；pi 消息 → OpenAI 消息（assistant 空消息跳过、tool_calls arguments JSON 序列化、toolResult → tool 角色 + 占位文本）；tools → function 工具 + `tool_choice: "auto"` 透传。
- **`src/llm/sse-parse.ts`**：SSE 增量解析（与 ST sse-stream.js 同语义：空行分隔/多 data 行 \n 连接/注释行跳过），纯逻辑可单测。
- **`src/llm/st-backends-llm.ts`**：StreamFn 适配器。CSRF 头经 `GET /csrf-token`（script.js firstLoadInit 同法，结果缓存，401/403 清缓存；`'disabled'` 不带头）；SSE → pi 事件流（text_start/delta/end、toolcall_start/delta/end、done/error，finish_reason 映射同 pi mapStopReason）；错误路径全部编码为 `stopReason: "error"|"aborted"` + 中文 errorMessage：401 会话鉴权 / 403 CSRF / 429 限流（quota 检测兼容 `quota_error` 与上游 `error.type/code=insufficient_quota`）/ 502·504 上游 / 其他状态透出 `{error:{message}}` / 流中 `{"error":…}` chunk / 断流（EOF 无 [DONE] 无 finish_reason）/ 超时（缺省 5 分钟，options.timeoutMs 优先）/ 取消（options.signal，含调用前已 abort 的竞态）/ 网络错误。`createStLlmPort(getContext)` 构造 core `LlmPort`（source/model 缺失抛中文错误）；runtime 暴露 `createLlm()`（任务开始时快照一次）。
- **测试**：mock fetch 覆盖请求形状（ST 特有字段 + CSRF 头 + tools 透传）、SSE 跨块/UTF-8、工具调用跨块累积、全部错误路径、CSRF 缓存/disabled/缺省端点；**Agent 交叉验证**（pi-agent-core Agent × 本适配器两轮工具循环：tool_calls → 工具执行 → 第二轮文本，请求体 tools 透传 + tool 角色回传 + content_filter 错误入 state.errorMessage）——ticket 13 的消费方式端到端验证。
- **真机验收脚本**：`docs/playwright-st-extension/verify-llm-adapter.mjs`（无副作用：不写库不建数据）。**未运行**：需要本机 ST（127.0.0.1:8000）已配置可用 Chat Completion 源——密钥在 ST 服务端配置，插件不接触 key。跑法：`node docs/playwright-st-extension/verify-llm-adapter.mjs`。
- **bootstrap 调试全局**：`__STE_MEMORY_RUNTIME__`（含 createLlm）供真机脚本调用；非公开 API，注释已说明。

## Comments

- 2026-08-10 code-review（双轴并行）结论：无 blocker。Spec 轴采纳 4 条修复：①流中上游错误 chunk（`{"error":…}`）不再静默丢弃——透出真实原因（否则误报「响应流意外中断」）；②quota 检测兼容流式路径——ST `forwardFetchResponse` 原样转发上游 body，`quota_error` 包装只出现在非流式路径，需同时认 `error.type/code = insufficient_quota`；③`options.signal` 调用前已 abort 的竞态——once 监听器不触发，try 开头显式检查；④`#createOutput` 防御模型对象缺失（StreamFn 契约：一切失败编码进事件流）。Standards 轴判断级：assistant 文本提取与 contentToText 去重（提取 `textBlocksOf` 共用）。未采纳（判断级）：调试全局按 NODE_ENV 门控——真机验收跑 prod build，门控会破坏验收路径，注释已说明非公开 API；401→400 重写语义——上游鉴权失败以 400 到达，措辞「ST 代理请求失败（400）：{上游原文}」已含真实原因，记录在案。
- 已知取舍（记录在案）：`include_reasoning: false` 固定——v1 不解析思考流（delta.thinking / reasoning_content），上游思考段忽略，reasoning 事件映射留待需要时扩展；usage 恒 0（ST 流不透出用量）；`max_tokens`/温度等生成参数复用 ST 用户配置（任务输出预算 = ST 的 openai_max_tokens）。
- 遗留：真机冒烟（验收标准第 4 条）待用户在真实 ST 环境跑 `verify-llm-adapter.mjs`（前置：ST 已配置 Chat Completion 源）。
