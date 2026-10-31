# 新前端开发与验收

开发约定统一见 [前端开发规范](./frontend-development.md)，包含公共组件、作用域与提交边界、
移动端交互和 ST 样式隔离，以及文字阴影、原生下拉框双重箭头的回归要求。本文维护功能概况和验收入口。

默认 `pnpm build` / `pnpm watch` 已使用 `src/frontend/index.ts`。新前端覆盖记录列表、
搜索与分页、详情及证据、编辑和新建、保存失败重试、修订冲突与切对话草稿保留。
移动与桌面采用同一套页面导航，旧前端入口、页面、组件与样式已移除，共用模型迁入 `src/frontend/models/`。
表格页支持表与字段管理、显示策略预览、向量配置与补建/重算/清除。
任务页支持楼层填表、初始化、队列与历史、取消重试、对话自动填表覆盖，以及向量任务筛选和批量取消；
填表页显示当前任务进度和楼层覆盖条，覆盖条可展开逐层方格、点击未计划区间填入填表范围；提交前确认楼层、批次与生效配置；当前对话可覆盖清洗规则和 Agent 预设。
离开任务页、关闭工作台或隐藏浏览器后停止轮询，后台任务继续执行。
检索页支持选择表与分组、Top K 与最低分、覆盖诊断、取消和跳转记录证据。
设置支持 Agent 连接及请求头、Embedding、重排、全局自动填表、Agent 与表格预设、清洗规则、
全局与对话宏的编辑和测试。设置首页按分组列出入口与实时状态，日志页提供搜索、级别/类型/
任务 Key 筛选、分页、日志详情与同任务跳转。表格预设可编辑结构和排序，向量分组可从预设库按 Key 导入。
主导航的 Agent 提供查询与填写交互；设置的工具区提供向量搜索、日志、备份/恢复、空间记录清除和 SQL 控制台。
全局自动填表与对话覆盖均支持「延迟填写楼层数」，默认 1，允许为 0，对话留空继承全局。
同时支持「成功后自动隐藏楼层」和「隐藏时保留最近楼层数」，保留数允许为 0。
对话可显式开启、关闭或跟随全局；数字留空移除对应覆盖，「全部跟随全局」同时清除隐藏设置。
记忆助手会话按 ST 对话身份与记忆空间隔离，支持新建、重命名、切换及删除；历史、输入和未提交提案在当前浏览器 IndexedDB 中保存。后台 run 在切页时继续，确认提交受实时对话身份与代次校验。

本轮按优先级完成：滚动与返回位置 → 连接及检索闭环 → 预设/规则/宏配置 → 问答与维护工具。
预设详情可进入增量比较，按表、字段和向量分组 Key 勾选变更并确认应用，保留未选内容与已有字段类型。
比较结果在对话或来源预设变化后作废；提交后的同步警告按原目标保留，保存重试不重复应用变更。
表格详情和向量编辑页可分页查找记录，查看已保存配置或未保存草稿的最终分组输入；
预览不写配置、不提交索引、不请求 Embedding，切回页面或重开工作台会刷新当前记录状态。
记录列表搜索框旁提供统一排序菜单，由记录服务对全部匹配结果排序后分页；偏好按空间与表保存，字段失效恢复默认。
记录页可切换列表与只读表格，表格内点击直接编辑记录；三行预览、固定表头和行号，返回恢复横纵位置及焦点。
两种视图共用搜索、排序与分页，视图模式按对话和空间保留在工作区内存中。
表格选择旁提供图标视图切换，表格带圆角和固定在右侧的铅笔编辑列；整格均可 hover 和点击。

页面共享 `src/frontend/components/` 中的页头、内容区、保存栏、确认弹窗、
离开保护、开关字段与状态提示；表格与预设共用 `SchemaEditorFields`，全局与对话自动填表共用
`AutoFillFields`，设置编辑共用 `SettingsEditor`。`workbench.tsx` 统一管理导航和关闭操作，
768px 以下使用底栏，桌面改为左侧紧凑纵列，页面与离开保护共用同一套逻辑。
`host/use-panel-window.ts` 管理桌面拖动、八方向缩放、键盘操作和视口边界，
通过 CSS 变量更新几何尺寸，拖动时不触发页面重绘；位置和大小保留到浏览器刷新前。
公共页头提供拖动区域，按钮操作保持独立；双击页头或聚焦后按 Home 恢复初始窗口。
记录、表格与任务各自的工作区负责当前对话状态和异步请求归属，设置保持全局作用域。
`usePageScroll` 按工作区、对话与视图缓存滚动位置；异步加载完成再恢复，进入详情/编辑使用独立容器。
这部分状态不依赖整页保活，也不写入用户设置。

## 独立预览

```sh
pnpm install --frozen-lockfile
pnpm preview:frontend
# http://127.0.0.1:18825/，?dark 为暗色；PORT 可改端口
```

预览使用真实新页面、浮层与工作区，内存服务提供两个对话、三张表和多种字段。
顶部对话选择用于模拟 ST 的外部切换。刷新重置预览中的记忆数据；助手会话使用独立的本地 IndexedDB 数据库 ste-memory-assistant-preview，刷新后保留，不连接 ST 或真实模型。
预览与生产共用 esbuild 配置及 Tailwind 编译函数，JS 改动自动重建，刷新查看。

```sh
cd docs/playwright-st-extension
pnpm install --frozen-lockfile --ignore-workspace
# CHROME 为本机 Chrome / Edge / Chromium 路径
CHROME=/usr/bin/chromium node verify-frontend.mjs
```

Windows PowerShell 可使用：

```powershell
$env:CHROME='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
node verify-frontend.mjs
node verify-tables.mjs
node verify-workbench.mjs
node verify-task-cancellation.mjs
node verify-floor-progress.mjs
node verify-connections.mjs
node verify-search.mjs
node verify-cleaning.mjs
node verify-macros.mjs
node verify-presets.mjs
node verify-preset-structure.mjs
node verify-query.mjs
node verify-assistant-concurrency.mjs
node verify-assistant-scroll.mjs
node verify-sql.mjs
node verify-logs.mjs
node verify-log-layout.mjs
node verify-maintenance.mjs
node verify-auto-fill.mjs
node verify-fill-notifications.mjs
node verify-preset-update.mjs
node verify-vector-preview.mjs
node verify-record-sorting.mjs
node verify-record-table.mjs
node verify-desktop-window.mjs
```

`FRONTEND_URL` 可更改地址，`FRONTEND_SCREENSHOTS` 可更改截图目录。
默认截图在 `node_modules/.cache/frontend-preview/screenshots/`，不进入 Git。
脚本验证分页、证据语义、离开确认与焦点、草稿恢复、失败重试、保存中切对话、
停用字段保留、新建类型值、搜索恢复、冲突和 320px 窄屏布局；同时捕获页面异常。

工作区单元测试重点覆盖过期请求、A → B → A、同空间不同对话、保存归属、
原字段结构保留和超过 100 条引用选项的分页。

## ST 接入

生产继续从现有 `dist` 安装或 Junction 加载，ST 顶部书本按钮打开新工作台。
设置 → 基础设置 → 入口位置可选择顶栏、魔法棒或两处显示，立即保存并更新入口。
入口使用 ST 原生 Font Awesome 与交互样式；真实 ST 的入口专项验收运行 `node verify-entry.mjs`，
通过 `ST_URL` 指定地址（默认 `http://127.0.0.1:8000`），脚本拦截设置保存请求，避免改写用户的 ST 设置文件。
切换 ST 对话会同步更新工作区；原对话未保存的修改在本次页面内保留，返回后继续。
保存使用原有 Memory 事务和对话文件写回，失败显示在顶部，可重试。
真实 ST 验收应使用专门的测试对话，重点检查保存期间切换对话、文件写回和刷新重载。

## 本轮验证（2026-10-28）

全仓 Vitest 160 文件、1702 项通过，含真实 SQLite/IndexedDB 的恢复、重建与提交后失败边界。
生产构建、类型检查、ESLint 与格式检查通过。
Edge 中 17 组浏览器流程共 344 项通过，覆盖记录与排序、表格滚动、任务与日志跳转、连接、
检索、预设结构编辑及增量更新、逐记录向量预览、清洗、宏、问答、SQL、维护和自动填表，
含 320px、390px 移动布局、桌面同流程及宿主样式隔离检查。
Windows 粗调度下的万条记忆语义查询采用 8ms 时间片检查点，保留真实宏任务、取消与截止时间检查；
强化调度回归沿用原 10 秒预算，避免固定每百行等待一次计时器带来的累计调度延迟。
真实 ST 仅做无数据写入的接入检查：入口、面板开关、焦点恢复及 Worker/WASM 资源加载通过，
没有插件页面异常；未对用户聊天执行记录写入或文件重载验收。

## 记忆助手专项验证（2026-10-29）

统一助手、会话与 Agent 运行基础设施、运行时及维护接线的定向回归通过；补充验证连接配置失败后的原消息保留，以及提交中断恢复。
Edge 独立预览完成助手 21 项、维护工具 13 项检查，覆盖多会话 CRUD、输入与提案刷新恢复、工具消息、明确确认、取消、对话隔离与 320/390px、桌面布局。
类型检查、ESLint、格式检查与生产构建通过。全仓并发回归期间出现宏查询预算、构建时限及队列等待失败，三个用例单独串行复跑通过，未改动这些阈值。
本轮仅使用独立预览的模拟记忆与模型，未对真实 ST 聊天执行写入验收。

记忆助手审查修复追加验证：35 项会话回归和 13 项真实多标签页浏览器检查通过，覆盖同提案仅提交一次、活跃请求不被误恢复、原页退出后恢复、排队取消、旧快照拒绝、v9 升级及切页/收起面板后的刷新保护。单条写入的保存错误测试从实际 repository 提交路径抛错，验证领域包装后的已提交语义。

## 旧前端清理验证（2026-10-29）

旧入口、页面、kit、样式、旧预览及旧 DOM 验收脚本已移除；11 个共用模型与测试迁入 `src/frontend/models`，移除无引用的 dnd-kit 依赖。
全仓 Vitest 130 文件、1469 项通过；模型迁移后的架构约束补充测试通过。
类型检查、ESLint、格式检查和生产构建通过。Chromium 独立预览的记录、表格、预设结构、自动填表、工作台、记录排序共 6 组、165 项检查通过。
另有 4 组现有脚本未通过，已在清理前的 HEAD 副本同样复现：verify-presets 假设删除后无其他预设；
verify-connections 仍查找“查询 Agent”；verify-cleaning 假设初始无清洗规则；verify-macros 仍查找旧删除按钮。
本次未修改这些既有断言或相关产品行为，不能将这 4 组计为通过。未执行真实 ST 对话写入验收。

## 自动填表通知验证（2026-10-31）

自动填表通知改用 shadcn Base UI Toast。77 项定向单元测试、通知专项 17 项浏览器检查及现有
`verify-frontend.mjs` 主流程通过；类型检查、ESLint、相关文件格式检查和生产构建通过。
覆盖工作台收起后的显示、重开后的层级、任务跳转与草稿离开保护、范围更新、对话切换隔离、
320px 长错误文本、亮暗主题、F6 聚焦和自动消失。使用独立预览模拟数据，未写入真实 ST 聊天。

## 任务取消确认验证（2026-10-31）

填表、单个向量及批量向量任务统一使用危险操作按钮与确认弹窗，默认聚焦「继续运行」。
取消专项 13 项浏览器检查、现有工作台流程和 12 项工作区测试通过；类型检查、ESLint 和生产构建通过。
验证首次点击不取消、继续运行与 Esc 保留任务、确认后取消、320px 弹窗布局，以及切换对话后旧确认失效。
使用独立预览模拟任务，未取消真实 ST 任务。

## 日志滚动与详情布局验证（2026-10-31）

日志列表组保留自然行高，详情按内容高度排布，防止 Flex 收缩后裁掉列表或压扁正文。
320px 与桌面布局专项 17 项检查及原有日志流程通过，覆盖滚轮、长日志正文滚动、元信息、
关联日志可达、返回列表的位置恢复与横向溢出。类型检查、ESLint、相关文件格式检查和生产构建通过。
使用独立预览模拟日志，未清空或修改真实 ST 日志。
