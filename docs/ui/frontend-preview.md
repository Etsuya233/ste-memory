# 新前端开发与验收

默认 `pnpm build` / `pnpm watch` 已使用 `src/frontend/index.ts`。新前端覆盖记录列表、
搜索与分页、详情及证据、编辑和新建、保存失败重试、修订冲突与切对话草稿保留。
移动与桌面采用同一套页面导航，旧前端源码保留且不进入默认 bundle 或样式。
表格页支持表与字段管理、显示策略预览、向量配置与补建/重算/清除。
任务页支持楼层填表、初始化、队列与历史、取消重试，以及向量任务筛选和批量取消；
离开任务页、关闭工作台或隐藏浏览器后停止轮询，后台任务继续执行。
设置页支持插件和对话文件同步开关、超时保存，其他配置展示只读摘要。
检索、高级设置编辑、从预设库导入向量分组及逐记录向量输入预览仍待迁移。

页面共享 `src/frontend/components/` 中的页头、内容区、保存栏、确认弹窗、
离开保护、开关字段与状态提示；`workbench.tsx` 统一管理底部导航和关闭操作。
记录、表格与任务各自的工作区负责当前对话状态和异步请求归属，设置保持全局作用域。

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

全仓 Vitest 149 文件、1631 项通过，随后新增的两项任务提交竞态回归也通过。
生产构建、类型检查、ESLint 与格式检查通过。
Edge 中记录流程 22 项、表格流程 29 项、任务与设置流程 23 项通过，
含 320px、390px 移动布局、桌面同流程及宿主样式隔离检查。
真实 ST 仅做无数据写入的接入检查：入口、面板开关、焦点恢复及 Worker/WASM 资源加载通过，
没有插件页面异常；未对用户聊天执行记录写入或文件重载验收。
