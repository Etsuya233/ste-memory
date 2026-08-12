# ST 插件 grilling 会话记录（2026-08）

本文件是「SillyTavern 记忆表格插件」从立项到拆票的完整讨论记录：逐轮问题、你的回答、调研事实、权衡与未选方案。spec.md 记录结论，本文件记录**推导过程**，供后续回溯（尤其当某个决策需要被重新审视时）。

## 1. 背景与目标

core/api/web 已建成可运行的记忆表格系统（领域模型 + 实验工作台）。目标是接入 SillyTavern：让记忆表格真正服务长对话生成——对话自动成为记忆数据源、表格与记录在酒馆内管理、记忆内容注入提示词。

会话开始时你明确的两条约束：

1. **目标是 UI Extension 而非 Server Plugin**（纯前端，无服务器组件）
2. **api/web 是实验工作台**：插件不利用 api/web 的代码，两者分别复用 core；未来可能用 api 代码库做 Server Plugin

你的使用场景：**云酒馆**（浏览器，多设备访问同一地址）+ **TauriTavern**（iOS 本地客户端）。

## 2. 逐轮决策记录

### Round 1 — 设计树前沿（六个问题）

| 问题 | 你的决定 | 落点 |
|---|---|---|
| Q1 能力范围 | **C 全搬**（管理 UI + 交互式填写都进 ST）；api/web 留作实验台 | 插件=自包含客户端 |
| Q2 空间粒度 | **每 ST 对话一个记忆空间** | core 词汇「记忆空间」不变，绑定是适配器层 |
| Q3 消息身份 | **先用楼层**（ST 消息数组下标） | ADR 0003 |
| Q4 工程位置 | **monorepo 新包**；发版拉 `sillytavern-release` 分支、manifest 放根目录 | 支持 ST 按 URL 安装 |
| Q5 通信 | 不利用 web/api 代码；你回忆 ST 有「无 CORS 外部网络接口」 | 后证实 = ST backends 同源代理 |
| Q6 注入 | **ST Macro，用户手动放 preset** | ADR 0004；宏名后来定为可配置 |

### Round 2 — 存储、共享资产、范围收敛

| 问题 | 你的决定 | 落点 |
|---|---|---|
| Q1 存储 | 不确定（倾向 Dexie，你有 SQL 基础）；提出「序列化存角色卡/对话元信息」的疑问；云同步必须做 | 引出发散讨论（见 §3.5、§3.6） |
| Q2 共享资产 | **B：收共享包**（如系统表模板）；**清洗规则不移植**（ST 自带 Regex 替代）；**任务状态机为 ST 重新设计** | 根 ADR 0020 |
| Q3 回填/旧消息 | **默认手动点**；自动功能晚做；路线图 = 存储 → 手动建表/改字段/改内容 → 手动指定楼层填表 → Macro | 路线图 §4 |
| Q4 同步细节 | 先查 ST 存储再讨论 | §3.3 |
| Q5 填表触发 | **手动触发**，自动后续再做 | ticket 13 |
| Q6 交互 UI | **顶部按钮 + 自绘浮层** | ticket 06 |
| Q7 管理 UI | **先只做系统表 + 表格/字段启停**，其余后续 | 字段编辑器后移 |

### Round 3 — ST 存储事实与云同步需求

- 呈现 ST 数据存储事实（见 §3.3），直接回应你的疑问：**不建议把大数据库序列化进角色卡/chatMetadata**（saveChat 全量重写聊天文件、角色卡粒度是角色而非对话）。
- 你：**云同步至少要做**（Google Drive 等），不直接传回 chatMetadata；并**纠正我**——ST-Memory-Context 的同步在你多设备上真实生效（后证实其把数据写进 chatMetadata，随聊天文件走，数据量小所以可行）。
- 你认可插件新 context `apps/st-extension`（词汇表 + ADR 目录）。
- Phase 1 范围认可；Macro 补充：**自定义宏，不写死**（未来可能做很多 ST 定制）。

### Round 4 — 云同步方案收敛

- 更正：ST-Memory-Context 确实用 chatMetadata 同步（`chatMetadata.gaigai` 等），localStorage 只是本地缓存——**小数据可行，大数据不可行**的边界由此确认。
- 新事实：`variables.global` 存服务器 settings.json，可跨设备但全量重写、与全扩展共享。
- 方案空间：Google Drive（OAuth，无 API Key 模式）/ WebDAV（坚果云无 CORS，浏览器直连不可行）/ S3 兼容（API Key 风格 + 原生 CORS）/ 未来 Server Plugin。
- 你：**云酒馆 + TauriTavern 双端**；本地跑时优先取本地数据、后台定时序列化同步；iOS localStorage 可能被清——**云同步是持久层**。
- 你：先做 API Key 或 WebDAV；数据先实现保存和持久化防丢失。

### Round 5 — 选型定稿

- TauriTavern 调研：**Tauri v2 + Rust 重写**（前端 1.18.0 保留，Node 后端换 Rust）；WKWebView 存储可被驱逐（iOS < 17 尤甚）；**Rust 后端不支持 Node 服务器插件** → 未来 Server Plugin 路线覆盖不了 TauriTavern，云同步是双端唯一通用持久层。
- 坚果云 WebDAV 确认无 CORS；Drive 只有 OAuth。
- 你：**先用 Cloudflare R2**。同步模型认可：本地优先 + 防抖周期推送 + 空库拉取 + 每空间文件 + LWW。

### 审阅与收尾

- 你审阅 spec 提三点：① 字段定义编辑器与自定义表格矛盾 → **写入范围**（Phase 2，单独拆票）；② **ChatMetadata 同步器记入未来候选**（先不做）；③ **前端风格先定**避免大改。
- UI 风格：你选择**自包含视觉**（不依赖 ST 主题变量、自绘简单组件、移动端优先、操作高效、界面整洁）；色板要**留 CSS 变量**方便后续调整 → 「记忆账本」风格契约（§5）。
- 拆票：15 张垂直切片（§6）。

### 设计修订（2026-08，票拆分后）

- **取消「同步游标」概念**：插件不存消息全文（ADR 0003），ST 就是消息源，楼层范围随时从 `chat` 实时读取——「已同步到第几楼」没有独立存在价值（该概念是 api「消息导入」心智的残留）。「哪些楼层已填表」由**填表任务的楼层进度台账**（untracked/processed/error，块成功 markProcessed、块失败 markError，与 api 同语义）记录。
- 相应改动：ticket 05 改为「空间绑定与 ST 事件桥」（CHAT_CHANGED 切换空间上下文；MESSAGE_SENT / MESSAGE_RECEIVED 仅注册为未来自动填表触发点、当前无消费方，不做消息追加/对账/面板刷新）；ticket 13 明确维护楼层进度台账；glossary「同步楼层」去掉「同步进度标记」；spec 决策 4/5 与测试决策同步更新。
- 遗留容忍：删消息致楼层漂移时，台账可能有超出 `chat.length` 的陈旧记录——无害，覆盖视图按 live 楼层渲染。

## 3. 调研事实（本地源码验证 + 网络调研）

### 3.1 SillyTavern UI Extension API（release 1.18.0）

本地源码：`tmp/SillyTavern_Source_Code`（tag 1.18.0）；文档：`tmp/SillyTavern-Docs`。

- **打包**：目录含 manifest.json（必填 display_name/js/author）+ ES Module 入口 js，浏览器直接加载，无需构建步骤；**不能 import node_modules**（只有相对 URL import 与 `SillyTavern.libs`）。
- **安装位置**：`extensions/third-party/<name>/`（全部用户）或 `data/<user>/extensions/<name>/`（仅自己）；支持 URL 安装（仓库根要有 manifest）。
- **getContext()**：`chat`（消息数组）、`chatId`（对话文件名，无 .jsonl）、`characterId`（索引，群聊 undefined）、`chatMetadata`（随对话文件持久化）、`extensionSettings`（按用户持久化）、`macros`（新宏引擎）、`eventSource`。
- **消息身份**：**ST release 没有稳定 id/hash**——身份就是数组下标；删除/重生成/swipe 都会移位（对应我们选楼层身份的动机）。
- **事件**：`MESSAGE_SENT`（用户消息入列，带下标）、`MESSAGE_RECEIVED`（AI 消息入列，带下标与类型 normal/swipe/regenerate…）、`CHAT_CHANGED`、`CHAT_RENAMED`、`CHAT_DELETED`、`EXTENSION_SETTINGS_LOADED`；**没有 CHAT_UPDATED**；payload 不统一，需查发射点。
- **setExtensionPrompt(key, value, position, depth, scan, role, filter)**：position 是数字枚举 `IN_PROMPT=0 / IN_CHAT=1 / BEFORE_PROMPT=2`；同 key 重注册即替换。**我们选择不用它**（宏注入，ADR 0004）。
- **宏**：新引擎 `context.macros.register(name, {handler})`；**handler 严格同步**（返回 Promise 会被字符串化）；每次生成时展开、不缓存；标识符约束：字母开头 + 字母数字连字符，大小写不敏感；注册同名覆盖并警告。→ 宏读预计算快照（ADR 0004）。
- **设置面板**：无 registerExtensionSettings API，直接往 `#extensions_settings` 追加 DOM；持久化 extensionSettings + `saveSettingsDebounced()`。
- **侧栏面板 API 已删**（createExtensionMenu 不存在于 release）→ 顶部按钮 + 自绘浮层。
- **LLM 同源代理**（关键）：`POST /api/backends/chat-completions/generate`（src/endpoints/backends/chat-completions.js:2157），同源 + `getRequestHeaders()` CSRF 头，无 CORS，复用用户当前 Chat Completion 配置与密钥（密钥在服务器 secret store）；支持 streaming（SSE）与 **tools/tool_choice 透传**；**未文档化内部 API**，body 需 ST 特有字段（chat_completion_source/type 等）——适配器隔离风险。
- **无通用无 CORS 代理**：`/proxy/:url` 存在但默认关闭（404）；`getRequestHeaders()` 同源调用是唯一保证无 CORS 的路径。
- 参考插件先例：`tmp/st_other_memory_plugin_example/ST-Memory-Context`——1.5 万行 vanilla JS、顶部工具栏图标、自绘 UI、localStorage 本地缓存 + **chatMetadata 同步**（数据量小才可行）。

### 3.2 ST 服务器数据存储

- 对话文件 = 服务器上的 jsonl，**第一行是 ChatHeader** `{chat_metadata, user_name, character_name}`（script.js:7347-7370）。
- **saveChat 每次把整个对话数组 + metadata 全量 POST 重写**（script.js:7350 → /api/chats/save → chats.js:458-466）→ chatMetadata 只适合小数据。
- chatMetadata 随对话文件走：重命名跟随、导出/备份/换设备同步文件都在。
- `writeExtensionField` 写角色卡 `data.extensions.<key>`（/api/characters/merge-attributes）——**粒度是角色不是对话**，不适合空间绑定。
- `variables.global` 存 extension_settings.variables.global → 服务器 settings.json，跨设备同步，但全量重写、与所有扩展共享，不适合大数据库。
- 浏览器存储（localStorage/IndexedDB）按 **origin 隔离**：ST 地址变了就换一套；多 profile 共享同一 origin。

### 3.3 TauriTavern（你的 iOS 客户端）

- Tauri v2 + Rust 重写 SillyTavern（前端 1.18.0 保留，Node 后端换 Rust，HTTP 请求被拦截转本地 Rust 命令；iOS 经 TestFlight，iOS 16+）。
- 数据主权在 Rust 文件系统（app sandbox），但 **WKWebView 的 localStorage/IndexedDB 由 WebKit 管理、可能被系统驱逐**（iOS < 17 无自定义 data store identifier）——你的「LocalStorage 可能丢掉」判断成立。
- **Rust 后端不支持 Node 服务器插件** → 未来 Server Plugin 路线（api 代码库）覆盖不了 TauriTavern。

### 3.4 云同步服务选型事实

- **Google Drive**：私有数据只有 OAuth（client ID + 授权流），**没有 API Key 直连模式**；CORS 由 Google 支持；留作后续适配器。
- **坚果云等 WebDAV**：**不返回 CORS 头**，浏览器 fetch 直连不可行（社区多项目确认）；除非自建 Cloudreve/Nextcloud 并开 CORS。
- **S3 兼容（R2/B2/OSS/COS）**：access key + secret（API Key 风格）、**原生 CORS**（为浏览器上传设计）、有官方 JS SDK；R2 免费 10GB 无流量费。
- **代价**：密钥明文存浏览器设置（与项目无认证现状一致，ADR 0017 精神）。

## 4. 路线图（你的「一步一步来」原则）

1. **Phase 1 底层架构**：工程骨架 + 构建链 → Dexie 持久层 → 空间绑定与消息同步 → UI 壳（含系统表/字段启停）→ 手动导出/导入
2. **Phase 1.5**：R2 云同步
3. **Phase 2 手动 CRUD**：建表 + 字段定义编辑器 + 显示策略 + 记录增删改
4. **Phase 3 手动楼层填表**：LLM 适配器 → 任务状态机与触发 → 任务面板
5. **Phase 4 记忆宏**
6. **后期（未排期）**：自动回填/自动填表、交互式填写 Agent 面板（硬闸门确认）、Google Drive 适配器、ChatMetadata 同步器候选、Server Plugin、TauriTavern 原生桥（`window.__TAURI__`）

已接受的已知局限：楼层漂移不传播、LWW 冲突、密钥明文、backends 端点未文档化、空库期间面板显示同步中状态而非报错。

## 5. UI 风格契约（「记忆账本」方向）

- **自包含视觉**：手写简单组件，不依赖 ST 主题变量，类名前缀 `stm-` 隔离；深色为默认，浅色后置。
- **色板全部走 CSS 自定义属性**（`--stm-*` 设计令牌，集中一处）：墨底 `#171A20`、浮面 `#21252E`、墨字 `#E7EAF0`、次字 `#98A0B2`、签名色铜绿 `#6FA894`、成功 `#7FB08A`、危险 `#C96A6A`、警示 `#D9A25F`。
- **字体**：正文系统 CJK 栈；楼层号/时间/计数用等宽数字。
- **布局**：移动端优先——手机全屏底部抽屉 + 底部 Tab（表格/记录/任务/设置），触控 ≥44px；桌面浮动面板同一套 Tab；表格自绘紧凑账本行（字段值 + 证据 chip 同排）。
- **签名元素**：证据楼层 chip（铜绿 + 等宽 `#N`，点按跳转 ST 消息，悬停/长按浮出原文摘录）——全插件唯一花哨点。
- **动效**：只留抽屉开合 + 同步状态变化；尊重 reduced-motion。
- **文案**：「空状态是邀请」风格。

## 6. 拆票结果（15 张，见 issues/01-15）

前沿 = 01（共享包收编）、02（工程骨架）。关键依赖：05 依赖 01（模板进共享包才装系统表）；07 → 08（序列化格式先定再上云）；12（LLM 适配器）独立可先行；13 依赖 12；09/10（字段/显示策略）先于 11（记录）——按你定的「建表→改字段→改内容」。

## 7. 文档产物清单

- `CONTEXT-MAP.md`：新增 st-extension context
- `apps/st-extension/CONTEXT.md`：同步楼层 / 记忆宏 / 记忆空间绑定
- `apps/st-extension/docs/adr/0001~0004`：自包含架构 / 存储分层 / 同步楼层身份 / 宏注入
- `docs/adr/0020`：系统表模板收编共享包
- `.scratch/st-extension/spec.md`：完整 spec（47 条用户故事）
- `.scratch/st-extension/issues/01~15`：tickets
- 本文件：会话记录（推导过程）

## 8. 可回溯的外部参考

- ST release 源码与文档：`tmp/SillyTavern_Source_Code`、`tmp/SillyTavern-Docs`
- 参考插件：`tmp/st_other_memory_plugin_example/ST-Memory-Context`
- 研究员简报：`.pi-subagents/artifacts/outputs/d2f5855c/research.md`（ST 扩展 API）、`3f9ffdbe/research.md`（backends 端点/宏/代理）
- 官方文档：docs.sillytavern.app（Writing Extensions / Macros / API Connections）

## 9. 开工前必读（新对话实现导航）

按顺序读，缺一不可：

1. **仓库导航**：`AGENTS.md`、`CONTEXT-MAP.md`、`docs/agents/`（issue-tracker / triage-labels / domain）
2. **插件上下文**：`apps/st-extension/CONTEXT.md`、`apps/st-extension/docs/adr/0001~0004`
3. **相关根 ADR**：`docs/adr/0020`（共享包）、`0010/0011`（字段证据/证据存储）、`0013`（JSON payload）、`0017`（无认证）、`0018`（agent 引擎）、`0019`（交互式填写）
4. **本目录**：`spec.md`（结论）、本文件（推导过程）、`issues/`（对应 ticket）
5. **core 契约与参照实现**：`core/src/memory`（domain / application / ports）、`apps/api/src/adapters/outbound`（SQLite adapter 参照）、`apps/api/src/application/fill-tasks`（填表行为基准，块大小 20）
6. **ST 事实与源码**：本文件 §3（已核实事实摘要）、`tmp/SillyTavern_Source_Code`（release 1.18.0，查证用）、`tmp/SillyTavern-Docs`、`tmp/st_other_memory_plugin_example/ST-Memory-Context`（参考插件）
7. **测试先例**：`apps/web/src/api/*.test.ts`（纯逻辑测试，无 jsdom）、`apps/api/test/*`、core 端口测试；测试基建 = vitest + fake-indexeddb

**开工规则**：只做当前 ticket 的验收标准；不重新调研 ST（事实已核实）；不改 spec/ADR（有出入先回来讨论）；术语用 glossary 词汇。

## 10. 问答面板 grilling 会话（2026-08，QueryAgent 接入）

主题：为 ST 插件接入 QueryAgent（core 已有只读问答 Agent，api/web 11.5 已做调试聊天先例，ST 插件已有填表 Agent）。逐轮决策：

### Round 1 — 定位与边界

| 问题 | 你的决定 | 落点 |
|---|---|---|
| Q1 定位 | **C 用户功能 + 调试工具兼得** | spec 决策 15 |
| Q2 能力边界 | **B 双模式**（查询 + 交互式填写，对齐 api/web sidebar-mutate-agent） | ticket 20 |
| Q3 思考流 | **B 升级适配器**展示思考（pi 原生 thinking 事件，已核实 0.83） | ticket 19 |
| Q4 上下文 | **A v1 纯记忆问答**（不附剧情） | spec 决策 15 |

### Round 2 — 形态与机制

| 问题 | 你的决定 | 落点 |
|---|---|---|
| Q5 入口 | **A 面板新 Tab「问答」**，内部「查询/填写」模式切换；复制回答有、发送到对话无 | ticket 20 |
| Q6 闸门 | **A prompt 软闸门**（对齐 api/web，硬闸门后续） | ticket 20 |
| Q7 历史 | **A 页面内存**（按空间×模式，刷新即失） | ticket 20 |
| Q8 预设 | **A 不扩展**（core 固定提示词，预设档案保持填表专用） | ADR 0009 |
| Q9 日志 | **A 不落通用日志**（交互式过程 UI 即记录） | ADR 0009 |
| Q10 剧情上下文 | **A 零注入**（"把刚才的对话记下来"走后台填表任务） | ADR 0009 |

### Round 3 — 收尾

| 问题 | 你的决定 | 落点 |
|---|---|---|
| Q11 运行中切对话 | **A 查询继续、填写提交前校验空间一致** | ticket 20 决策 7 |
| Q12 拆票 | **B 两票**：19-思考流适配器升级；20-问答面板（双模式） | issues/19、20 |
| Q13 文档产物 | **全部落**：ADR 0009 + spec 决策 15/故事 48-50 + 术语 + session-record + tickets | 本文件 |
| Q14 思考流开关 | **B 按消费者开**（缺省 false，填表任务零变化——你追问「为什么影响填表任务」后收敛） | ticket 19 决策 1 |

### 沿用先例（未再开问题）

并发写入直通不经守卫（web 决策 8）、revisionSource = "agent"（决策 10）、提交后不自动刷新给刷新入口（决策 7）、取消 AbortController / stopReason "aborted"、总超时 5 分钟、多轮无状态回传工具结果不跨轮、无 LLM 配置表单（ST backends 复用用户配置）、静默降级。

### 事实补充（本轮核实）

- ST generate 端点支持 include_reasoning 透传（chat-completions.js:459/561：thinkingConfig includeThoughts；326-348 各后端 thinking 配置）——解除 v1 已知取舍可行。
- pi-ai 0.83 原生 thinking_start/thinking_delta/thinking_end 事件与 ThinkingContent 块（dist/types.d.ts:393-405）——解析输出无需自定义事件。
- 适配器为共享件（runtime.ts:175 createStLlmPort 唯一实例、buildStGenerateBody 写死 include_reasoning: false、流解析只消费 delta.content/tool_calls）——思考流升级天然牵动填表任务，故拆独立票 19 且缺省关。
