# Agent 引擎采用 pi-agent-core（位于领域层之外）

Memory Application 层内的 agent 子层（`core/src/memory/application/agent`）采用 `@earendil-works/pi-agent-core` 作为通用 Agent 引擎，位于领域层之外，与 ADR-0008 的边界保持一致。pi 的 `AgentMessage`、`AgentTool`、`Context`、agentLoop 事件与 `streamFn` 抽象在 agent 子层内作为一等公民原样使用：不为消息、工具、请求参数或通用 Agent 循环发明自己的包装类型，避免无价值的适配器重复。记忆领域层（`core/src/memory/domain`）保持纯领域，不引入 pi 及其类型；记忆表格、记忆记录、证据、引用约束与修订规则仍由领域层独占。`@earendil-works/pi-*` 与 typebox 是模块内唯一被约束的引擎依赖：只有 agent 子层允许 import 它们，架构测试强制该约束。

与领域层的唯一边界沿用 ADR-0008/0016 的模型无关端口：Agent 可多次调用只读查询端口（`MemorySpaceReader`），所有写入最终汇总为一个跨表原子批次，经提交端口以修订批次形式进入记忆；工具实现只调用这些应用层端口，不直接写库。pi 与领域之间只有一个翻译点：pi 的回合与工具结果 → 带字段证据的 Agent 提案，提案经端口提交后才成为正式记忆状态。pi-agent-core 支持通过 `declare module` 扩展 `AgentMessage`（`CustomAgentMessages` 声明合并），提案形状可直接混入 pi 消息体系，无需包壳。

LLM 调用通过 `streamFn` 抽象完成，agent 子层内部不感知厂商协议。Node 端可使用 pi-ai 的 `Models.streamSimple` 直连；SillyTavern 前端扩展场景下，浏览器端实现自定义 `streamFn`，用 fetch 调用 SillyTavern 自带的 `/api/backends/chat-completions/generate`（同源代理，无 CORS），把 OpenAI 兼容 SSE 转回 pi 的事件协议。pi-agent-core 主入口已实测无 Node 内置依赖，可被 Vite/esbuild tree-shaking 到最小面（`Agent` + `streamProxy`）约 227KB 原始 / 64KB gzip，适合打包进 SillyTavern 前端扩展。

不选方案：让领域层直接依赖 pi 类型，放弃 Messages/Tools/请求/Workflow 的领域对象。该方案虽省去翻译，但会把引擎的类型与版本契约渗透进核心规则层，违反 ADR-0008，并使领域测试耦合 pi 运行时；通用 agent 管道概念不属于领域语言（见 CONTEXT.md）。领域工作流（回顾对话 → 生成提案 → 审阅 → 应用批次）仍作为应用层用例描述，pi 只提供通用 Agent 循环。
