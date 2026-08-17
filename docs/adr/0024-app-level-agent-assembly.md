# App 层可独立组装 Agent：core 开放运行基础设施

ADR 0019 已把工具定义与 Agent 解耦：5 个工具工厂、ProposalState、digest 构建与 prompt 组合器全部从 agent 子层公开导出，`ProposalAgent` 只是"工具清单 + prompt 组合器"的薄装配。但装配 Agent 所需的运行基础设施（`runAgentWithTimeout` / `convertAgentMessagesToLlm` / `abortedAgentRunSummary` / `RunHooks` / `AgentRunSummary`，`agent-run.ts` 内部已导出）未进入公开面——`ProposalAgent` 仍是唯一可运行的装配，App 想完全控制 Agent（自定义消息序列、自定义工具集、循环事件处理）会在最后一步卡死，只能复制循环逻辑或回到默认装配。这是半成品缝：core 做出了"零件可组装"的姿态，却没交出装配所需的最后一块拼图。

## 决策

1. **core 开放运行基础设施**：`agent/index.ts` 公开面补上 `runAgentWithTimeout`、`convertAgentMessagesToLlm`、`abortedAgentRunSummary`、`RunHooks`、`AgentRunSummary`。App 层从此可用 core 导出的零件 + pi-agent-core 的 `Agent` 自行装配（`new Agent` + `convertToLlm: convertAgentMessagesToLlm` + `runAgentWithTimeout`），并在 core 工具旁混入 App 自有工具（如扩展侧的内容清洗工具）。
2. **`ProposalAgent` 保留为默认装配**（convenience default）：api 的交互式填写（chat-manager）与后台填表任务（fill-task-service）、扩展侧的 FillTaskService 继续使用，零行为变化；其角色从"唯一入口"降格为"默认管线"，不再是 core 对 App 的唯一承诺。
3. **可变性走组合不走参数**：不给 `ProposalAgentRunInput` 增加消息序列/工具集/循环行为的开关参数。参数化导致选项笛卡尔积、全部组合需一起测试、core 需预知所有未来变体；组合让变体局部化在需要的 App 里。
4. **领域不变量以契约测试锁定在默认装配上**：digest 每次 run 构建一次且提示词/工具共用、system 角色合并进系统提示词、对话最后一条必须 user、ProposalState 每 run 新建、总超时硬中止。App 自定义装配以这些测试为行为基准，防止各 App 重新推导时悄悄漂移。

## 边界

App 组装意味着 App 直接依赖 pi-agent-core 运行时（`Agent` 类、`streamFn`），这是 ADR 0018 已接受的成本（tree-shake 后约 227KB raw / 64KB gzip，适合打包进 SillyTavern 前端扩展）。ADR 0008/0018 的边界不变：领域层（`core/src/memory/domain`）仍不 import pi 类型，agent 子层是 pi 的一等公民面，不设包装层；超时=硬中止、取消=abort 信号、摘要=最后一条助手消息的运行语义仍由 core 独占定义，App 不复制。

## 不选方案

- **RunInput 参数化**：配置爆炸、组合测试成本、core 需预知所有未来变体（见决策 3）。
- **装配整体移出 core**：api 与扩展各自复制循环与超时/取消语义，Agent 行为漂移，违反 ADR 0008/0019 的共享管线精神。
- **维持现状**（运行基础设施私有）：半成品缝，App 完全控制需求被堵死。

## 现状与后续

本决策只开放能力，不要求迁移：st-extension 当前继续用 `ProposalAgent` + `composeMessages` 缝（消息编排由预设控制），行为不变。后续若扩展侧需要自定义工具（如把内容清洗规则做成工具）或完全自定义消息序列，按本 ADR 在 App 层组装，不回流 core。
