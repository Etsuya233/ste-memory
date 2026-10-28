# 新前端开发与验收

默认 `pnpm build` / `pnpm watch` 已使用 `src/frontend/index.ts`。新前端覆盖记录列表、
搜索与分页、详情及证据、编辑和新建、保存失败重试、修订冲突与切对话草稿保留。
移动与桌面采用同一套页面导航，旧前端源码保留且不进入默认 bundle 或样式。
表结构、任务、检索和设置页面待后续迁移。

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

全仓 Vitest 146 文件、1608 项通过；随后补充的快照重试集成测试与相关聚焦测试通过。
生产构建、类型检查、ESLint 与格式检查通过。
Edge 中独立浏览器流程通过，含 320px、390px 移动布局与桌面同流程截图。
真实 ST 仅做无数据写入的接入检查：入口、面板开关、焦点恢复及 Worker/WASM 资源加载通过，
没有插件页面异常；未对用户聊天执行记录写入或文件重载验收。
