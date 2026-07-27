# 01 — 建立可运行的本地实验骨架

**Type:** task

**What to build:** 建立可直接启动的 TypeScript 实验工程，划分 Domain、Application、HTTP API、Web 和适配器边界，并提供 Core 数据库与 HTTP Adapter Source Store 的独立 SQLite 配置。

**Blocked by:** None

**Status:** resolved

- [x] 工程可以在本地安装依赖、执行迁移、启动 API 和 React Web。
- [x] Domain 不依赖 HTTP、SillyTavern、LLM SDK 或具体数据库。
- [x] API 提供健康检查，Web 可显示 API 和数据库连接状态。
- [x] Core SQLite URL 与 HTTP Source Store SQLite URL 可分别配置，也允许指向同一个 SQLite 文件。
- [x] 默认 API 只监听 `127.0.0.1`，当前版本不引入认证。
- [x] 提供最小单元测试、迁移测试和启动说明。
- [x] 新增代码文件均不超过 300 行，必要处有说明性注释。

## Comments

- 已建立 TypeScript workspace，划分 Domain、Application、Core SQLite、HTTP API、Source Store 和 React Web 边界。
- `npm run typecheck`、`npm test`、`npm run build` 均通过；已用共享 SQLite 文件完成迁移和 API 健康检查烟测。
