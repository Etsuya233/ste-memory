# 预设与宏预览：查看活动预设实际生成的消息 + 当前宏实际内容

Feature spec。前置依赖：消息编排 1:1 改造（另一个 grilling session 的课题，见 Comments）。

**Status:** ready-for-agent

## Problem Statement

Agent 提示词预设（ticket 17 / 23）的占位符在**任务提交时**才展开，用户无法在提交前看到活动预设实际生成的消息——只能盲提交填表任务或凭记忆猜展开结果；记忆宏（ticket 15 + 双 Scope 系统）与 Agent 预设宏（`{{tablesDigest}}`/`{{systemDefaultPrompt}}`）的实际展开内容也存在预计算快照里（服务侧 `getSnapshot` 读口现成），但设置面板只列宏名与摘要，看不见内容。用户编辑预设/视图后需要即时确认效果。

## Solution

两个只读预览，全部在设置 Tab 内完成，不引入新 Tab：

1. **预设预览**（「Agent 提示词预设」编辑器内）：「预览」按钮 → 内嵌只读面板，展示活动预设按编排语义展开后的最终消息序列，逐条分组（角色标签 + 来源预设消息名 + 展开后文本）。展开数据**点击时即时构建**：ST 上下文（对话双方名字、角色卡、Persona，复用 `adapter.getPromptSnapshot`）+ 记忆空间摘要（digest）+ **预览输入文本**（手动输入，同时作为 `{{msg}}` 展开源与 `{{worldbook}}` 扫描输入）。
2. **宏预览**（「记忆宏」组内）：记忆宏家族（`{{前缀}}` 默认快照、全局视图、聊天 Scope 宏、内置 `full`/表 Key）+ Agent 预设宏（`{{tablesDigest}}`/`{{systemDefaultPrompt}}`）逐行「预览」展开，展示宏的**实际展开文本**。数据源 = 两个宏服务的预计算快照（与宏 handler 返回同源；设置/数据变更路径已有 kick 立即重建，编辑后查看即最新）。

## User Stories

1. 作为用户，我可以在预设编辑器里预览活动预设实际生成的消息（每条消息按角色与来源分组展示展开后文本），以便提交填表任务前确认提示词效果
2. 作为用户，我可以在预览面板手动输入一段消息内容，作为 `{{msg}}` 的展开内容与世界书扫描输入，以便模拟任务块的展开效果
3. 作为用户，我在预览面板看到「预览为当前时刻内容，任务提交时以最新数据重新展开」的提示，以便不把预览结果当作承诺
4. 作为用户，我可以在「记忆宏」组内展开每个宏（默认快照、视图、聊天 Scope 宏、内置宏、`{{tablesDigest}}`/`{{systemDefaultPrompt}}`）查看实际展开文本，以便确认放入提示词/角色卡后会出现什么
5. 作为用户，我编辑记忆视图/宏配置/预设消息后立即打开预览看到的是最新内容，以便编辑-查看闭环
6. 作为用户，无活动记忆空间时宏预览显示空态提示，以便知道宏当前无可展开内容
7. 作为用户，我可以复制展开后的消息文本，以便直接取用

## Implementation Decisions

1. **编排形态假设**：本 spec 按「编排已改造为 1:1——每条启用且非空预设消息按序成为一条最终消息，system 不合并」的形态设计预览展示（用户决策：编排改造另立 grilling session，本功能默认该改造落地）。若该 session 结论维持合并，仅调整展示分组（system 块内分段标注来源），其余设计不变。
2. **占位符展开**：复用 `expandAgentPresetPlaceholders`（单遍展开、未知占位符原样保留、同语义）；
   - `{{user}}`/`{{char}}`/`{{char_card}}`/`{{user_card}}`：点击预览时从 ST 上下文即时读取（`adapter.getPromptSnapshot()`，与任务快照同源同构）；
   - `{{tablesDigest}}`/`{{systemDefaultPrompt}}`：点击时即时构建 digest（`buildMemorySpaceTableDigest` + core 组合器），无活动空间 → 空摘要（与任务语义一致）；
   - `{{msg}}`：展开为**预览输入文本**；为空 → 空串 + 面板内标注「{{msg}} 依赖任务块消息，预览中为空」（与 Q2 决策一致）；
   - `{{worldbook}}`：预览输入文本经 `scanWorldbookText` dry-run 扫描（真实执行）；输入为空 → 不扫描，显示标注；扫描失败/旧版 ST → 空串 + 标注，不阻断预览。
3. **ST 宏原样保留**：预设文本中用户手写的 ST 宏（`{{time}}` 等）在真实链路（ST backends chat-completions/generate 端点，服务端不做宏展开，已核实源码）中原样发送——预览同样原样保留，不展开、不标注。
4. **预览输入文本**：面板内 textarea，手动输入；**同时**作为 `{{msg}}` 展开源与 `{{worldbook}}` 扫描输入（同一任务中本就是同一份块消息，语义一致）；默认空，不做「填入最近消息」预填（后续迭代）。
5. **宏预览数据源 = 预计算快照**（读 `MemoryMacroService.getSnapshot/getViewSnapshot/getChatScopeSnapshot` + `AgentMacroService.getSnapshot`），不即时重算——快照就是宏 handler 的返回源，重算制造双源不一致；新鲜度由既有 kick 路径保证（视图/宏名/上限/聊天 Scope 宏变更、空间切换、面板数据操作均触发 kick，另有 2s 指纹轮询兜底）。展开时读一次，面板展开期间不订阅自动刷新（预览是查看不是监控）。
6. **宏预览落地 = 「宏内容一览」只读分区**：置于「记忆宏」组内（取代在 MemoryViewsManager / ChatScopeMacrosManager / BuiltinMacrosList 三处各自加展开——改动面大且与既有编辑折叠交互拥挤）：一次性列出全部当前宏——默认快照（{{前缀}}）、全局视图、聊天 Scope 宏、内置宏（full + 每启用表）、Agent 预设宏（{{tablesDigest}}/{{systemDefaultPrompt}}）；每行 = 宏名 + 展开文本（长文截断可展开）+ 复制；空快照显示「（空）」不隐藏；无活动空间 → 分区内空态提示（沿用 builtin-macros-no-space 先例）。
7. **UI 形式**：预设预览 = 编辑器顶部「预览」按钮 + 内嵌只读面板（逐条卡片：角色标签 + 来源预设消息名 + 展开文本 + 复制按钮）；预览按钮仅出现在自定义预设编辑区（选中系统默认时无预览——其展开内容即 {{systemDefaultPrompt}} 宏，经「宏内容一览」查看）。
8. **宿主端口（执行接线清单）**：AgentPresetManager 新增只读端口 props：`getPromptSnapshot`（adapter 同源）、`readSpaceId`（活动空间 id，undefined = 无空间）、`readDigest`（空间 id → digest）、`scanWorldbook`（输入文本 → 扫描文本）；宏内容一览分区端口：`readMacroSnapshots`（聚合两个宏服务快照的只读读口，host 在 panel-shell 组装）。预览构建逻辑进「预览 model」纯函数（单测），组件只接线。
9. **差异提示**：预设预览面板顶部一行小字「预览为当前时刻内容，任务提交时以最新数据重新展开」。
10. **测试**：组件测试（AgentPresetManager 预览交互：按钮/输入框/渲染/标注；宏内容一览展开交互）沿用 testing-library 模式；预览构建的纯逻辑（输入文本 → 快照 → 编排消息）抽 model 单测；宏内容一览快照聚合（两服务快照 → 行列表）抽纯函数单测；宏预览零新服务逻辑（只读快照）。
11. **验收清单**：(1) 自定义预设点「预览」→ 面板逐条展示启用且非空消息（角色标签 + 来源名 + 展开文本），未知占位符原样保留；(2) 面板输入文本 → {{msg}} 展开为输入内容、{{worldbook}} 展开为扫描结果，无输入时两者按标注/空串处理；(3) 编辑预设消息后重开预览内容为最新；(4) 宏内容一览列出全部宏且内容 = 快照实际值，编辑视图/宏名/数据后立即为最新；(5) 无活动空间时一览显示空态，预设预览正常可用（digest 占位符空）；(6) 复制按钮可用。

## Non-Goals

- 不改造消息编排行为（1:1 直发 vs 合并）——另立 grilling session（见 Comments）。
- 不做宏预览的实时订阅刷新（Q9 决策）。
- 不做「填入最近 N 条消息」预填（Q8 决策，后续迭代）。
- 不展开 ST 宏（与真实链路一致）。
- 预览不落库、不进运行记录。

## Comments

编排 1:1 改造的 grilling Prompt（用户自备，可用于新 session）：

> 我想改造 Agent 提示词预设的消息编排行为……（背景：当前多 system 消息按序空行合并为一条系统提示词，core `proposal-agent.ts` systemTextOf；期望改为每条启用且非空 system 消息按序直接成为一条最终消息，不再合并。关键点：多 system 消息在各上游的兼容性与是否按 source 分流或保留合并选项；core 组合器改动面（PromptMessagesComposer 契约、systemTextOf、composeSystemPrompt 兜底、「最后一条必须 user」守卫、运行记录快照语义）；插件侧改动面（fill-task-service 编排、{{msg}} 接管、世界书快照、日志）与 apps/api/问答面板影响（走字符串组合器路径）；ST 提示词体系的交互；测试回归范围。关键文件：core/src/memory/application/agent/proposal-agent.ts、prompt-composer.ts；apps/st-extension/src/agent-presets/preset-composer.ts、fill-tasks/fill-task-service.ts；docs/adr/0006-agent-prompt-presets.md；.scratch/st-extension/issues/23-agent-preset-message-orchestration.md）

会话决议速记：Q1 按消息分组不堆叠；Q2 {{msg}} 空串 + 标注；Q3 ST 宏原样保留；Q4 宏预览范围 = 记忆宏家族 + Agent 预设宏；Q5 数据源 = 预计算快照（kick 保证编辑后最新，已核实 panel-shell 各变更路径）；Q6 手动输入文本作为世界书扫描输入；Q8 输入文本同时展开 {{msg}}，默认空；Q9 展开时读一次不订阅；Q10 无空间显示空态；Q11 差异提示一行；Q12 组件测试 + 纯逻辑 model 单测；Q13 编排按 1:1 假设（改造另立 session）。