# 自包含 UI Extension 架构（打包 core，不依赖 api/web）

ST 记忆表格插件是纯前端 UI Extension（manifest + 单文件 bundle），与 apps（api/web）互不依赖：不调用其 HTTP 服务、不复用其代码。插件与 api/web 各自从 core 取领域与应用层能力；浏览器端实现全部宿主适配器（持久化、同步、Agent 运行）。api/web 保持为实验工作台，两者并行演进。

选择自包含的原因：UI Extension 没有服务器，唯一可共享的资产是 core（pi-agent-core 主入口已实测无 Node 内置依赖，可 tree-shaking 进浏览器，见 ADR 0018）；「ST 与 api/web 无关」使实验台的改动不会波及插件。LLM 调用经自定义 `streamFn` 走 ST 自带的同源代理 `/api/backends/chat-completions/generate`（`getRequestHeaders()` 的 CSRF 头，无 CORS，复用用户已配置的模型与密钥，支持 tools 透传）——该端点未文档化，是内部 API，故在适配器内隔离，版本升级漂移风险由适配器层承担。

未来路线：Server Plugin 可复用 api 代码库（数据库、任务管理等宿主逻辑），但只覆盖浏览器 + 云酒馆场景——TauriTavern 是 Rust 后端，不支持 Node 服务器插件。

不选方案：插件通过 HTTP 调用 apps/api（引入对实验台进程的运行时依赖、CORS 与配置负担，违背「ST 与 api/web 无关」）；直接做 Server Plugin（目标是 UI Extension）；浏览器端引入 React 等框架（ST 运行时无 node_modules，单文件 bundle 限制，原生 DOM/jQuery 足够）——**已修订：UI 渲染层采纳 React 19（esbuild 打包进单文件，见 ADR 0005）**。
