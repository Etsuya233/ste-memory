# 新前端开发与验收

开发约定统一见 [前端开发规范](./frontend-development.md)，包含公共组件、作用域与提交边界、
移动端交互和 ST 样式隔离，以及文字阴影、原生下拉框双重箭头的回归要求。本文维护功能概况和验收入口。

默认 `pnpm build` / `pnpm watch` 已使用 `src/frontend/index.ts`。新前端覆盖记录列表、
搜索与分页、详情及证据、编辑和新建、保存失败重试、修订冲突与切对话草稿保留。
移动与桌面采用同一套页面导航，旧前端源码保留且不进入默认 bundle 或样式。
表格页支持表与字段管理、显示策略预览、向量配置与补建/重算/清除。
任务页支持楼层填表、初始化、队列与历史、取消重试、对话自动填表覆盖，以及向量任务筛选和批量取消；
离开任务页、关闭工作台或隐藏浏览器后停止轮询，后台任务继续执行。
检索页支持选择表与分组、Top K 与最低分、覆盖诊断、取消和跳转记录证据。
设置支持 Agent 连接及请求头、Embedding、重排、全局自动填表、Agent 与表格预设、清洗规则、
全局与对话宏的编辑和测试。表格预设可编辑结构和排序，向量分组可从预设库按 Key 导入。
设置的工具区提供查询/填写问答、日志、备份/恢复、空间记录清除和 SQL 控制台。
全局自动填表与对话覆盖均支持「成功后自动隐藏楼层」和「隐藏时保留最近楼层数」，保留数允许为 0。
对话可显式开启、关闭或跟随全局；数字留空移除对应覆盖，「全部跟随全局」同时清除隐藏设置。
问答历史按空间与模式保存在页面内存中，后台 run 在切页时继续，切空间后填写提交仍受服务校验。

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
顶部对话选择用于模拟 ST 的外部切换。刷新重置全部数据，不连接 ST、数据库或模型。
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
node verify-connections.mjs
node verify-search.mjs
node verify-cleaning.mjs
node verify-macros.mjs
node verify-presets.mjs
node verify-preset-structure.mjs
node verify-query.mjs
node verify-sql.mjs
node verify-logs.mjs
node verify-maintenance.mjs
node verify-auto-fill.mjs
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
