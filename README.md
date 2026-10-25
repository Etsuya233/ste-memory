# STR-MEMORY

SillyTavern 长对话记忆插件的源码仓库：在对话文件之外维护可修订的「记忆表格」，
供角色卡与提示词预设通过宏注入当前认知，并支持手动编辑、Agent 填表、问答与
本地备份/镜像恢复。全部数据默认存在浏览器 IndexedDB 与对话文件（chatMetadata）
中，不依赖任何远端服务。

## Prerequisites

- [mise](https://mise.jdx.dev/)

项目通过 [`mise.toml`](./mise.toml) 固定 Node.js 与 pnpm 版本，不使用 Corepack。

## 开始

```bash
mise install
pnpm install
```

## 开发命令

```bash
pnpm watch        # esbuild watch 增量构建；配了 .env 就同步到 ST，Junction 模式自动跳过拷贝
pnpm build        # 产物写到 dist/：index.js / manifest.json / style.css
pnpm st:link      # 把 ST 扩展目录做成指向 dist/ 的链接（开发直连，见下）
pnpm st:unlink    # 解除该链接（只删链接，不动 dist）
pnpm typecheck    # tsc -p tsconfig.json
pnpm lint         # eslint .
pnpm format:check # prettier --check .
pnpm test         # vitest run
```

真实 SillyTavern 验收脚本在 [`docs/playwright-st-extension`](./docs/playwright-st-extension)，
通过 `window.__STE_MEMORY_RUNTIME__`（调试入口）驱动面板与数据流。

## 聊天 API 连接

在设置的「Agent 连接」中为表格填写 Agent、查询 Agent 选择独立连接。每个连接可配置
自己的请求头，支持键值行新增、删除和值隐藏；「测试连接」使用当前编辑草稿，模型列表
和实际生成共用请求头。修改地址、API Key 或请求头后，旧测试结果与模型列表清空。

API Key 默认生成 Bearer 鉴权，自定义 `Authorization` 可覆盖它；无 Key 且未配置
Authorization 时发送空鉴权值。`Content-Type` 固定为 `application/json`。请求头名称
不区分大小写，不允许重复，值允许为空但不能包含换行。API Key 和请求头值明文保存在
插件设置中；请求通过 ST 服务端的 Custom 代理转发。任务开始后沿用连接快照。

## 向量索引

在设置中保存独立的 OpenAI 兼容 embedding 连接，然后从表格的「向量索引」配置字段分组。
配置来源支持自动、预设和自定义；更新方式单独选择手动或自动。自动配置将启用字段合成一组，
每条记录的每个分组生成一个向量。表格预设保存当前分组快照，空间备份保留配置来源，均不导出向量或连接密钥。

任务页可按空间、表、状态、来源筛选向量任务，并逐项或勾选取消。队列优先手动任务，
同来源中优先当前对话；每次请求结束后重新排序。向量可补建、强制重算或单独清除，不改变记忆正文。

连接由浏览器直接请求服务的 `/embeddings` 接口，服务需允许当前 ST 站点跨域访问。
输入字符上限是本地限制，模型的 token 限制仍由服务校验；接口格式见
[embedding API 文档](https://developers.openai.com/api/reference/resources/embeddings/methods/create)。
面板「检索」按当前对话绑定空间选择表和分组，默认 Top K 为 10（可调 1–50），最低分默认关闭。
每次提交只为查询原文请求一次 embedding，在本地按余弦相似度排序，同一记录取最高组分并去重。
只搜索已有有效索引，不等待或触发补建；缺失、过期、异常及空输入目标会单独显示，部分索引仍可搜索。
查询与索引请求独立并发、分别取消和处理错误；查询失败不改变索引任务状态。

结果展示实际参数、检查时点、索引覆盖、各阶段耗时、命中组和输入来源，可打开原记录查看证据与修订。
查询、选区和结果只存在页面内，切对话或刷新清空；正文、结构、profile 或所选索引删除后标为过期，
纯向量新增与同指纹替换保留当前快照并提示重新搜索。搜索不接入宏、查询 Agent 或提示词注入。
查询长度上限为连接限制与 4000 字符中的较小值，超长需自行缩短，分数仅表示相似程度。
端点、模型及维度变化需重建；换密钥无需重建。同名远端模型更换权重无法自动识别，需强制重算。

## 自动召回

在「检索」页配置当前对话的自动召回，默认关闭。绑定已有全局记忆视图或对话命名宏，
为每个视图选择向量组，再把 `{{memoryRecall}}` 自行放入角色卡或提示词预设。
绑定固定作用域与视图名，采用视图的表和条件；视图的显示字段、排序和条数上限仍只用于原宏展示。
多个视图的候选合并后按相关度去重，默认 Top K 为 10，输出上限 4000 字符，可设置最低分。

新用户消息保存后，ST 等待召回准备，再展开本轮提示词。查询使用已保存正文，仅去除首尾空白，
不拼聊天历史、不调用 LLM 改写、不再次展开宏，也不套用填表清洗规则。
每次发送至多请求一次查询向量，同轮多次展开宏复用结果；开启后即使未放宏也会查询。
查询与手动搜索、索引任务独立，不等待补建，不自动重试。

召回最多等待 10 秒；失败、超时、超长、无有效索引或无匹配时使用空宏继续，原因在面板显示。
「跳过本次召回」只跳过检索，ST 停止按钮停止本轮生成。切对话或停止后不接受迟到结果。
重生成、swipe 和续写复用同一用户轮次仍有效的结果；刷新、切对话或资料失效后不恢复。
群聊一次用户消息共用一次召回；dry run、quiet、impersonate 及插件 Agent 不触发自动召回。
独立 dry run 的 token 预估不含召回文本；与正常发送并发时，ST 宏入口无法区分调用来源，
预估可能计入当前召回，正常发送优先使用本轮结果。面板可查看实际宏文本、范围和来源；插件不修改 ST 预设，
也不使用 `setExtensionPrompt` 自动注入。

## ST 安装与同步

开发用两种方式，二选一。

### 方式一：Junction 直连（推荐）

```bash
pnpm build     # 先产出一份 dist/
pnpm st:link   # 把 ST 扩展目录链接到 dist/（Windows Junction，无需管理员）
```

之后 `pnpm watch`（或 `pnpm build`）产出的文件 ST 直接可见，**不再拷贝**：

- 链接目标必须是构建产物 `dist/`，不是 TS 源码——ST 只加载 `index.js` /
  `manifest.json` / `style.css`，TS 必须先经 esbuild 打包；
- 改动生效仍需刷新 ST 页面（扩展以 module script 加载，无 HMR）；
- `pnpm st:unlink` 解除链接（只删链接，dist 内容不受影响）；目标已存在真实目录
  时会拒绝建立/删除，不会动用户数据。

### 方式二：拷贝

`pnpm sync` / `pnpm deploy:st` 会把 `dist/` 拷进 SillyTavern 的
`public/scripts/extensions/third-party/ste-memory`（**会写入 ST 安装目录**）。
目标位置从仓库根 `.env` 读取，二选一（参考 [`.env.example`](./.env.example)）：

- `STE_ST_EXTENSION_DIR`：直接指向扩展目标目录；
- `STE_ST_INSTALL`：SillyTavern 安装根目录，自动推导扩展子路径。

`pnpm watch` 不配 `.env` 时只构建到 `dist/`（配合方式一的 Junction 正好）；
配置了但目标已是 dist 链接时，同一步骤会自动跳过拷贝。

## 发布

`pnpm release:st` 重新生成 `release/sillytavern-plugin` 分支（构建产物分支，
SillyTavern 通过该分支安装/更新）。默认只更新本地分支，`--push` 才推送远端。

## 目录结构

```text
src/
├── index.ts / bootstrap.ts / runtime.ts   # 入口、ST 环境守卫、组合根
├── features/                              # 业务功能（直接函数/服务调用，无事件总线）
│   ├── memory/                            # 共享记忆模型与写入规则（唯一来源）+ 公开入口
│   ├── agent/                             # 提案/查询 Agent 运行与工具
│   ├── fill-tasks/  query-chat/  macros/  # 填表任务、问答面板、宏
│   ├── table-presets/                     # 表格预设：预设库、实例化、应用（原子重建）
│   ├── backup/  chat-mirror/              # 备份文件格式、镜像格式与导出辅助
│   └── settings/ cleaning/ chat-binding/ space-maintenance/ logging/ agent-presets/
├── infrastructure/                        # 具体实现：IndexedDB（Dexie）、SillyTavern 适配器、浏览器
├── ui/                                    # 面板 React 组件与纯逻辑模型（shell/memory/tasks/…）
└── common/                                # 跨功能的小工具（定时器端口、轮询骨架）
```

约束：

- 其他功能与 UI 只能通过 `src/features/memory/index.ts` 使用 Memory（领域类型、
  完整操作与持久化接口都在入口导出）；内部步骤（校验、修订、历史写入、显示文本
  计算）不对外暴露。
- 功能层不依赖 `infrastructure/` 与 `ui/`；具体实现由 `runtime.ts` 装配注入。
- `tests/architecture/` 与 ESLint `no-restricted-imports` 同时强制以上方向。
- 填表与问答通过记录服务的 `commitProposal` 提交，仓库、ID、时钟和显示计算由
  Memory 内部管理；填表提交和台账更新仍由外层组织同一个事务。
- 设置保存后的宏、镜像与聊天同步由 `SettingsService` 负责；设置页和表格页只接收
  实际使用的服务，UI 负责草稿与错误展示。
- 表格结构只在两处产生：首次创建对话时复制默认表格预设、设置页应用预设；两者共用
  `features/table-presets` 的实例化与原子重建路径，空间内的引用与显示策略在写入时
  按预设内的 Key 重新映射。

## 验证

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## 文档

- 领域与插件词汇：[`CONTEXT.md`](./CONTEXT.md)
- 结构决策：[`docs/adr`](./docs/adr)（插件决策在 `docs/adr/st`）
- 对话文件镜像格式：[`docs/chat-metadata-mirror.md`](./docs/chat-metadata-mirror.md)
- 记忆视图与记忆查询：[`docs/memory-views.md`](./docs/memory-views.md)
- 表格预设：[`docs/table-presets.md`](./docs/table-presets.md)
- 系统自带预设的默认表结构：[`docs/system-memory-tables.md`](./docs/system-memory-tables.md)
- 本轮架构收敛：[`docs/refactor-plan.md`](./docs/refactor-plan.md)、[`docs/refactor-progress.md`](./docs/refactor-progress.md)
