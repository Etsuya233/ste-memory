# UI 渲染层采用 React（修订 ADR 0001 的「不引入框架」表述）

面板 UI 渲染层采用 **React 19**（`react` + `react-dom`），随 esbuild 打进单文件 bundle（自包含约束不变：无外部资源、无运行时 CDN、不依赖 ST 主题）。本 ADR 修订 0001 中「浏览器端引入 React 等框架（ST 运行时无 node_modules，单文件 bundle 限制，原生 DOM/jQuery 足够）」的表述——该顾虑只关乎「运行时依赖 ST 提供框架」，而 esbuild 打包消除了它：React 只是构建期依赖，产物仍是单文件。

选择 React 的原因（2026-08-08 用户决策）：后续票的 UI 形态以**表单与列表**为主（字段编辑器 09、显示策略 10、记录 CRUD 11、任务面板 13/14、宏配置 15）——原生 DOM 手写值绑定/校验显示/脏状态/高频状态更新容易出 bug（ticket 06 实现中已实际踩过：漏设 id、事件属性缺失、异步渲染竞态），框架把这些变成免费能力；React 工具链（类型、生态、jsx 编译）齐全，与 esbuild 无缝。

架构约束（不变与新增）：

- **纯逻辑 seam 不变**：状态机/视图模型/文案仍在 panel-model / table-list-model / space-info（无 React 依赖，测试兜底不变）；组件只做「状态 → DOM」投影。
- **组件端口化**：组件依赖 `PanelRuntime` 端口（运行时子集），测试注入 fake，不依赖组合根。
- **测试决策微调**：仍不引入 jsdom/组件测试基建；组件层用 `react-dom/server` 的 `renderToString` 做无 DOM 冒烟（类名/aria/占位文案契约），异步加载路径由真机 Playwright 验收覆盖。
- **DOM 契约稳定**：类名/`data-action`/`data-stm-field` 属性是验收脚本（verify-ui-shell.mjs）的契约，组件与脚本同步演进。
- **构建**：esbuild `jsx: automatic`（React 自动 runtime 打进 bundle）；`process.env.NODE_ENV` 显式 define（dev=development / prod=production，react-dom 分支选择）。bundle 体积 ~155KB → ~352KB（minified），ST 加载无压力。

不选方案：Preact（体积更小但用户明确选择 React，生态/心智更通用）；Lit/web components（模板字符串风格，与手写 innerHTML 相近但工具链不如 React）；保持原生 DOM（见上文踩坑）；Vue（体积更大，团队无既有偏好）。
