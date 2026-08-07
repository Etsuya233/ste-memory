# Context Map

本仓库采用多上下文布局。每个 context 拥有自己的词汇表（`CONTEXT.md`）与上下文内决策（`docs/adr/`）；跨上下文决策放在根目录 `docs/adr/`。

## Contexts

- **core** — `core/`（`@ste-memory/core`）：领域模型与 Agent 引擎。词汇表：`core/CONTEXT.md`，包含全部领域词汇（记忆表格、证据、修订、记忆空间……）。
- **apps** — `apps/`：应用层，由 `apps/api` 与 `apps/web` 共同组成 **一个 context** —— 它们是一对：web 前端通过 HTTP 与 api 对话，两者共享同一套应用层词汇（如会话、查询等概念）。在 apps context 中定义的术语同时适用于 api 和 web，不单独属于其中任何一方。词汇表：`apps/CONTEXT.md`（尚无实际术语时懒创建）。
- **st-extension** — `apps/st-extension/`（SillyTavern UI Extension）：独立的应用层客户端，与 apps（api/web）互不依赖，两者分别与 core 共享领域词汇。SillyTavern 专属词汇（同步楼层、记忆宏等）只在本 context 定义。词汇表：`apps/st-extension/CONTEXT.md`。

## Rules

- 领域词汇只在 `core/CONTEXT.md` 中定义一次，所有 context 共享；不要在 `apps/` 中重复定义。
- 应用层词汇写入 `apps/CONTEXT.md`，同时适用于 `apps/api` 与 `apps/web` —— 永远不要只定义在"一对"中的一方。
- 一个 context 只有在其术语或决策真正被解析时才创建自己的 `CONTEXT.md` / `docs/adr/`（见 `docs/agents/domain.md`）。
