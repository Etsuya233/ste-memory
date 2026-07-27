# 01 — 建立可运行的本地实验骨架

**Type:** task

**What to build:** 建立可直接启动的 TypeScript 实验工程，划分 Domain、Application、HTTP API、Web 和适配器边界，并提供 Core 数据库与 HTTP Adapter Source Store 的独立 SQLite 配置。

**Blocked by:** None

**Status:** ready-for-agent

- [ ] 工程可以在本地安装依赖、执行迁移、启动 API 和 React Web。
- [ ] Domain 不依赖 HTTP、SillyTavern、LLM SDK 或具体数据库。
- [ ] API 提供健康检查，Web 可显示 API 和数据库连接状态。
- [ ] Core SQLite URL 与 HTTP Source Store SQLite URL 可分别配置，也允许指向同一个 SQLite 文件。
- [ ] 默认 API 只监听 `127.0.0.1`，当前版本不引入认证。
- [ ] 提供最小单元测试、迁移测试和启动说明。
- [ ] 新增代码文件均不超过 300 行，必要处有说明性注释。
