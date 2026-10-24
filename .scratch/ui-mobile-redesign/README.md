# 隔离 UI 预览

直接加载实际 PanelShell、功能组件和构建样式，内存 runtime 提供可编辑示例数据。无 IndexedDB、ST 适配器或远端请求；刷新会重置数据。外观与窗口几何仅使用预览站点自己的 localStorage。

仓库根目录执行：

```powershell
node --experimental-strip-types .scratch/ui-mobile-redesign/build.mjs
python -m http.server 8799 --bind 127.0.0.1 --directory .scratch/ui-mobile-redesign/preview
```

打开 http://127.0.0.1:8799/ ，可用 `?tab=tables`、`?tab=records`、`?tab=settings`、`?tab=retrieval` 指定初始页面。源码变化后重跑构建并刷新。

表格、字段、记录增删改保存会修改当前页面的内存数据；检索返回固定样例并可打开真实记录详情。向量预览、索引任务与连接均为内存示例，无网络请求。备份导入未实现并会显式抛错。图标使用预览页的字符占位，不依赖 ST 图标字体。

浏览器可通过 `window.__UI_PREVIEW__` 访问 model、runtime 和 getData()，便于验收定位。

服务启动后运行 `node .scratch/ui-mobile-redesign/check.cjs`，检查 360/390/430/1280px 下七个页面、记录保存取消、导航焦点、表格详情、外观和检索跳转。脚本默认使用已安装的 Microsoft Edge；可通过 `BROWSER_CHANNEL` 指定 Playwright 浏览器通道。若 Playwright 不在项目依赖中，将 `PLAYWRIGHT_MODULE` 设为可用 Playwright 包的绝对路径。截图输出在忽略的 `screenshots/`，构建产物在忽略的 `preview/`。

`node .scratch/ui-mobile-redesign/layout-check.cjs` 验证容器动态栏高、短视口与页面栏切换；`glass-check.cjs` 验证玻璃开关、持久化与深浅色。

`tables-check.cjs` 覆盖所有尺寸的表格单列导航、搜索、启停、字段依赖限制、编辑模式删除、编辑保存与脏保护、配置入口及创建删除；`pointer-check.cjs` 覆盖触屏按住整个胶囊放大、释放与取消、减少动态效果和鼠标 Hover。

`tasks-check.cjs` 验证填表与向量任务的操作、筛选、分页、详情、底栏隔离和滚动。`task-fixtures.ts` 提供混合状态任务与可变楼层台账，取消/重试/提交仅修改内存，不运行真实模型请求。

`secondary-check.cjs`、`settings-layout-check.cjs`、`settings-editors-check.cjs`、`settings-navigation-check.cjs` 与 `settings-details-check.cjs` 保留前轮验收记录。其中依赖 Agent 即时输入保存、原生名称 prompt 或清洗底部操作墙的选择器与流程需适配当前显式保存页面后再运行，不能作为本轮交互通过的依据。`logs-check.cjs` 保留日志页面回归。

本轮设置操作流通过 cua_repl 按390px视口人工验收，覆盖清单与结果见 `settings-flow-audit.md`；未执行 Playwright。连接请求、备份恢复与数据清空没有作用于用户数据。隔离镜像状态固定为 idle，无法用于证明真实镜像订阅更新。
