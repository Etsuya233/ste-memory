# 记忆助手与 shadcn AI Elements：可行性调研

调研日期：2026-10-29。范围为用户提供的 [shadcn AI Elements](https://ui.shadcn.com/docs/ai-elements)，按当前项目的 Base UI 分支核查。本文记录官方事实及接入推断，未安装组件、修改运行时代码或测量构建产物。

## 结论与适用边界

官方当前将 AI Elements 定义为可复制的 shadcn/ui 组合模式，基础构件包括 Message、Message Scroller、Trace、Input Group 等。页面同时提供旧 `elements.ai-sdk.dev` 的迁移说明。接入时可以复制所需模式、使用当前 Agent 数据；无需为了展示界面引入 Next.js 模板或迁移模型请求。后一句是根据各模式静态 Usage 和依赖核查作出的判断。[来源](https://ui.shadcn.com/docs/ai-elements)

官方演示大量使用 `useChat`、`UIMessage` 和脚本辅助函数，这些演示中的数据接线可以替换。Tool 文档明确要求调用方把工具状态映射到 Trace，Trace 自身不解析工具消息；Reasoning 的示例组件只需要文本与运行状态。[Tool](https://ui.shadcn.com/docs/ai-elements/base/tool)、[Reasoning](https://ui.shadcn.com/docs/ai-elements/base/reasoning)

## 可复用模式与真实接口

| 模式                    | 当前基础构件与接口                                                                                                                                                       | 接入自定义 Agent 的判断                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Chat / 旧 Conversation  | `MessageScrollerProvider`、`MessageScrollerViewport`、`MessageScrollerContent`、`MessageScrollerItem messageId scrollAnchor`、`MessageScrollerButton`；可选 `autoScroll` | 用项目稳定消息 ID；用户轮次作为锚点，保留现有会话归属               |
| Message                 | `Message align="end"`、`MessageContent`、`MessageFooter`，用户正文可组合 `Bubble`                                                                                        | 角色布局与正文渲染分离，可继续使用现有 Markdown                     |
| Prompt Input            | `form`、`InputGroup`、`InputGroupTextarea`、`InputGroupAddon align="block-end"`、`InputGroupButton`                                                                      | 发送、取消和草稿仍由现有工作区负责；附件与模型菜单按真实能力增添    |
| Reasoning               | `Trace`、`TraceLine`、`TraceTitle`、`TraceDescription`、`TraceCollapsible*`                                                                                              | 已有 thinking 文本即可使用；耗时需要真实计时数据                    |
| Tool                    | 运行中 `TraceLine status="running"`；结果到达后 `TraceCollapsible`；错误 `status="error"`                                                                                | 从现有工具调用 ID、名称、输入、结果与错误映射，无需创建 AI SDK 消息 |
| Task / Chain of Thought | Trace 内嵌 Trace；汇总行可折叠，内容 `keepMounted`                                                                                                                       | 可以汇总实际工具步骤；独立任务列表需运行时提供对应数据              |
| Sources                 | Trace 内可折叠来源列表，演示输入为 URL 与标题                                                                                                                            | 本地记忆记录需要项目定义可点击引用及证据数据                        |
| Inline Citation         | `HoverCard`、`HoverCardTrigger render={<Button ... />}`、`HoverCardContent`                                                                                              | 提供展示结构；引用编号、正文落点、记录关联需项目保证                |
| Confirmation            | `Item`、`ItemContent`、`ItemActions` 与普通按钮                                                                                                                          | 可借用视觉组合；确认回调继续使用项目提案版本校验                    |

来源：[Chat](https://ui.shadcn.com/docs/ai-elements/base/chat)、[Message](https://ui.shadcn.com/docs/ai-elements/base/message)、[Prompt Input](https://ui.shadcn.com/docs/ai-elements/base/prompt-input)、[Reasoning](https://ui.shadcn.com/docs/ai-elements/base/reasoning)、[Tool](https://ui.shadcn.com/docs/ai-elements/base/tool)、[Task](https://ui.shadcn.com/docs/ai-elements/base/task)、[Chain of Thought](https://ui.shadcn.com/docs/ai-elements/base/chain-of-thought)、[Sources](https://ui.shadcn.com/docs/ai-elements/base/sources)、[Inline Citation](https://ui.shadcn.com/docs/ai-elements/base/inline-citation)、[Confirmation](https://ui.shadcn.com/docs/ai-elements/base/confirmation)。

Trace 的展开状态可以使用 `open={userOpen ?? running}`：运行时展开、完成后收起，并让用户主动选择优先。父级汇总使用 `keepMounted` 可保存内部步骤的展开状态。工具失败、取消或等待的语义由业务状态判断，不能把所有已停止的调用都推断为失败。[Trace](https://ui.shadcn.com/docs/components/base/trace)、[Tool](https://ui.shadcn.com/docs/ai-elements/base/tool)

官方 Confirmation 示例针对工具执行前的批准，示例批准后会继续执行工具。项目若用于已经准备完成的提案提交，只借用外观即可，不能照搬示例中的自动继续执行逻辑。[Confirmation](https://ui.shadcn.com/docs/ai-elements/base/confirmation)

## 依赖与技术兼容

本次在项目目录执行了只读 `pnpm dlx shadcn@latest view trace message message-scroller code-block`，返回 `base-luma` 注册项。核查结果如下；实际添加时仍需查看 dry-run，不能把本表视为锁定版本。

| 构件               | 注册依赖和说明                                                                         |
| ------------------ | -------------------------------------------------------------------------------------- |
| `trace`            | 复用 `collapsible`，组件源码未依赖 AI SDK                                              |
| `message`          | React 与类名合并工具，组件源码未依赖 AI SDK                                            |
| `message-scroller` | 新增 `@shadcn/react`，实际导入 `@shadcn/react/message-scroller`，复用 Button           |
| `code-block`       | 复用 Button，注册项同时引入 `use-highlighted-code`；本体可直接显示文本，高亮 hook 独立 |

Message Scroller 的手动安装说明明确列出 `@shadcn/react`。它负责新轮次锚定、流式跟随、历史加载和跳转；恢复已有会话、用户滚离实时位置及内容展开的行为需要在项目中验证。[Message Scroller](https://ui.shadcn.com/docs/components/base/message-scroller)

Code Block 的高亮路径使用 Shiki JavaScript 引擎，语言按需加载；纯文本可跳过高亮 hook。当前 CLI 注册项会一并添加高亮支持，因此应分别确认安装依赖与最终 bundle 的实际引用，避免把“可选高亮”理解为 CLI 不会增加相关依赖。[Code Block](https://ui.shadcn.com/docs/components/base/code-block)

项目当前为 React 19、Tailwind 4、Base UI / Luma，基础方向匹配。仍需适配 `@/ui/primitives` 别名、`ste:` 类名前缀、主题与 Portal 容器；本地规范要求保留这些隔离措施。上述兼容判断属于静态评估，尚未通过浏览器验收。[项目前端规范](../ui/frontend-development.md)

## Markdown、流式体验与体积取舍

Message 模式推荐 Streamdown 来显示流式 Markdown，并可把代码围栏接到 Code Block。Message 的静态组件自身不强制采用某个 Markdown 渲染器，首轮完全可以保留项目现有渲染路径。[Message](https://ui.shadcn.com/docs/ai-elements/base/message)

Streamdown 支持未闭合 Markdown 的增量解析和分块记忆化；其安装文档支持当前 React 版本，并要求 Tailwind 扫描 `streamdown/dist/*.js`。额外代码、数学、Mermaid、CJK 功能走插件。应按当前页面内容需求选择，SQL / JSON 展示不需要一次性开启所有插件。[入门](https://streamdown.ai/docs/getting-started)、[内置处理](https://streamdown.ai/docs/plugins)、[未闭合语法](https://streamdown.ai/docs/termination)、[记忆化](https://streamdown.ai/docs/memoization)

项目采用 `ste:` 前缀与局部样式隔离；依赖内无此前缀的 className 无法仅靠增加 `@source` 自动获得对应运行时类名。Streamdown 的样式需要单独评估自定义组件映射、局部 data 属性选择器等接入方式；不要直接套用文档中的全局根节点样式。此处为基于项目构建规则与上游样式说明的推断。[上游样式](https://streamdown.ai/docs/styling)、[项目规范](../ui/frontend-development.md)

Streamdown 默认同时使用 HTML 清理与 URL 加固处理，但默认允许外部图片。若替换现有渲染器，应核对当前外部图片策略；覆盖 `rehypePlugins` 会替换默认数组，必须保留清理插件。Markdown 展示增强不应意外增加外部资源请求或放宽可执行内容边界。[Streamdown 安全说明](https://streamdown.ai/docs/security)

本轮未安装或构建新组件，无法给出可信的 KB 数值。预期增加来源包括 Message Scroller 包、Markdown 渲染层和高亮语言；实际发布环境使用 esbuild，仍需对比首次加载、构建产物与高亮按需加载行为。建议将结构组件改造与 Streamdown 迁移分开验证，便于量化收益及成本。

## 项目适配结论与建议范围

以下判断来自 2026-10-29 当前工作区的静态代码核对；尚未安装组件、制作界面或进行浏览器验收。本文中的 QueryAgent 对应项目当前称呼“记忆助手”。README、前端规范与 ADR 0030 已采用统一助手和持久化会话；CONTEXT.md 后部“问答面板”等条目仍有旧双模式描述，本次评估以当前代码和新 ADR 为准。

### 当前基础

项目使用 React ^19.2.8、Tailwind ^4.3.3、Base UI ^1.9.0、base-luma、Lucide、esbuild；精确解析版本以锁文件为准。shadcn CLI info 已确认 base=base、rsc=false、样式与别名。当前已安装 Item、Button、Accordion 等基础控件，尚无 Trace、Message、Message Scroller、Input Group、Code Block。

[query-message.tsx](../../src/frontend/pages/query/query-message.tsx) 用 Card 展示两种角色，Accordion 展示思考及工具，正文由 react-markdown 和 remark-gfm 渲染；每次工具调用展开后直接展示参数与结果 JSON。[query-page.tsx](../../src/frontend/pages/query/query-page.tsx) 同时组织会话列表、消息、提案及输入区，并自行实现距底部 80px 的跟随策略。[query-chat-state.ts](../../src/features/query-chat/query-chat-state.ts) 已有按真实顺序排列的 thinking/text/tool 片段，工具以 callId 回填结果。展示改造可以直接消费这些数据，无需引入另一套聊天消息存储。

[QueryChatService](../../src/features/query-chat/query-chat-service.ts) 的 run 只准备提案，confirm(sessionId, previewId) 才实际提交，并重新检查归属、预览差异和修订；[session-store.ts](../../src/features/query-chat/session-store.ts) 管理持久化、多会话及运行归属。这些能力继续由现有服务承担。UI 不应为了套用示例引入 useChat、AI SDK transport 或重复 store。

### 优先级与适配

| 优先级     | 采用内容                                   | 在项目中的呈现                                                                                       | 改动成本判断                               |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 第一轮     | Message / Bubble                           | 用户消息用紧凑气泡，助手回复以正文为主，保留复制和真实运行状态，减少每条消息的卡片头部占用           | 低，集中在 query-message.tsx               |
| 第一轮     | Trace + Reasoning / Tool                   | 在片段原位置展示可折叠的思考和工具步骤；工具显示中文动作、运行/成功/失败摘要，参数与结果仍可展开检查 | 中，需要工具状态映射和现有主题适配         |
| 第一轮     | Prompt Input                               | 用 Input Group 整合多行输入、发送和停止；保留输入草稿、保存失败提示、跨标签页执行状态及 busy 语义    | 低至中，集中在 query-page.tsx              |
| 第一轮     | Confirmation 的视觉组合                    | 整份待提交提案继续展示增删改及字段前后差异，配确认提交和放弃动作                                     | 中，复用 Item/Button；确认仍绑定 previewId |
| 第一轮可选 | Suggestion                                 | 空会话提供少量真实可用的查询示例；点击填入输入框供用户编辑，写入意图仍经过提案确认                   | 低，无需模型生成推荐                       |
| 单独一轮   | Message Scroller                           | 用户问题定位、流式跟随、跳回最新，与会话切换和原有阅读位置恢复共同设计                               | 中，需要调整滚动容器和唯一职责             |
| 后续       | Sources / Inline Citation                  | 把工具命中的记录呈现为可打开的来源，进一步支持回答句子与记录的精确关联                               | 中至高，需补充引用数据及导航接线           |
| 暂缓       | Plan / Task / Queue / Context / Checkpoint | 仅在运行时提供真实计划、进度、用量或可恢复语义后再展示                                               | 当前缺少相应展示契约                       |

工具摘要可以先使用真实参数和结果：query_records 已返回 table、total、records、display 与记录 ID，可显示“查询人物表 · 命中 3 条”；query_sql 返回 rows、truncated、limit，并可携带语义 sources/diagnostics，可显示返回行数与截断提示。错误必须展示真实错误，未知工具继续保留原工具名与原始详情。这里只做已知工具结果的展示，不从模型正文猜测成功与否。

片段顺序需要保持：例如“思考 → 文字 → 工具 → 文字”仍依次渲染。可以折叠连续的过程片段，但不能把全部思考和工具移到回答末尾。工具实际耗时、整个任务进度、token 占用目前没有对应展示字段，首轮不应编造。

### 四个需要明确处理的边界

**提案确认。** 官方 Confirmation 展示工具执行前审批，项目确认的是经过领域校验的整份提案。可以复用其 Item 与操作按钮布局，但提交继续调用现有 confirm 并传 previewId；新一轮交流使旧预览失效。提交失败、已提交但快照保存失败、提交中刷新待核对这三类反馈必须继续区分。提案保持一份会话级有效状态，避免在历史回复里留下可点击的旧确认入口。

**滚动。** 当前 PageContent 与 usePageScroll 按会话保存位置，query-page.tsx 还主动写 scrollTop。引入 Message Scroller 时需明确由谁控制流式滚动，移除同一容器上竞争的主动定位逻辑；保留会话间阅读位置、列表返回、关闭重开、用户主动上翻后的停跟随与“最新消息”入口。官方按用户问题锚定的新策略也会改变现有体验，应通过小范围验证后采用。

**样式。** 使用 Base UI 版本，新增基础控件归 src/ui/primitives，助手相关组合放在 src/frontend/pages/query；有明确复用需求后再提升至公共组件。沿用 ste: 类名前缀、stm-luma 主题、现有 cn 和 PrimitivesProvider。生产样式入口为 src/frontend/theme.css，聚合 primitives/theme.css，现有扫描范围覆盖这两个目录；如果另放 src/ui/ai-elements 等目录，需要显式检查扫描覆盖。新 Portal 必须接入插件容器，尤其关注 Tooltip、Hover Card 和弹层在 ST 原生 top-layer 面板中的位置。参考 [前端规范](../ui/frontend-development.md)、[样式构建](../../scripts/luma-styles.ts) 和 [PrimitivesProvider](../../src/ui/primitives/provider.tsx)。

**Markdown 和引用。** 第一轮保留现有 react-markdown 渲染路径：已有测试锁定原始 HTML、javascript 链接和远程图片行为，换消息外壳无需同时换 Markdown 引擎。Code Block 高亮或 Streamdown 可作为独立评估，核查依赖、ste: 前缀、扫描路径与产物大小后再决定。工具命中记录只说明读取了哪些数据；句子级引用还需模型输出与记录身份的明确关联。query_sql 的语义 sources 记录表、组和查询覆盖，不能直接等同于每句话的记录证据；任意 SQL 结果也未必包含记录 ID。

### 推荐落地顺序与验收

先完成一条 390px 的流程：发送查询 → 看清当前动作 → 阅读回答 → 展开工具详情 → 准备修改 → 查看字段差异 → 确认提交。第一轮采用 Message、Trace、Prompt Input 和提案布局，沿用现有 Markdown、滚动、会话及服务；稳定后单独评估 Message Scroller 与引用功能。如此可以分别验证视觉收益和交互策略的变化。

代码入口主要是 query-message.tsx、query-page.tsx，以及新增的少量 primitives。若增强工具摘要，直接在展示层消费已有结构化结果；只有新增引用协议、用量或步骤信息时才扩展事件与持久化模型。避免先把所有 UI 数据转换成 AI SDK UIMessage 再交给组件。

实施时复用 query-message.test.tsx 的时间线顺序与 Markdown 边界检查，运行 verify-query.mjs、verify-assistant-concurrency.mjs；公共控件变化补 verify-frontend.mjs 的宿主样式、焦点与弹层检查。至少覆盖 320px、390px、桌面缩小窗口、长 SQL、长 JSON、多轮工具、取消/失败、多会话切换、刷新恢复、无效预览与提交后同步失败。涉及滚动时再增加上翻阅读、切换会话恢复及输入区高度变化检查。最后按改动范围执行 typecheck、lint、格式和构建，并比较实际产物体积；本次调研未执行这些实现验收，也未提供体积估值。

### 本次检查记录

已阅读 README、前端规范、预览说明、统一助手 ADR，以及上述页面、状态、工具和服务代码；已核对官方网页与只读 CLI 元数据。shadcn CLI docs 返回 Trace、Input Group、Code Block 链接，对 Message 和 Message Scroller 返回“No documentation links available”，两者的网页文档仍可访问，后续安装前应再次核对实际 registry 可用性。没有执行 add、修改应用代码或安装项目依赖。本次只新增调研文档，原有工作区修改保持原样。
