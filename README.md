# STR-MEMORY

本仓库用于构建 SillyTavern 长对话记忆的本地实验工具。当前提供 Core、Core SQLite Adapter、HTTP API 与 React Web，并支持上传 SillyTavern JSONL 创建记忆空间、浏览原始聊天及管理空间；表格与对话处理功能将在后续工单中加入。

## Prerequisites

- [mise](https://mise.jdx.dev/)

项目通过 [`mise.toml`](./mise.toml) 固定 Node.js 和 pnpm 版本，不使用 Corepack。

## Start Locally

```bash
mise install
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm web:migrate
pnpm web:dev
```

API 默认运行在 `http://127.0.0.1:3000`，Web 默认运行在 `http://127.0.0.1:5173`。Web 首屏提供记忆空间列表，可上传 JSONL、浏览原始消息和解析错误，并进行重命名与删除。

默认 API 只监听 `127.0.0.1`，用于本机单用户实验，当前版本不提供认证。

## Configuration

每个 Adapter 维护自己的环境配置，不共享根级 `.env`：

- [`apps/api/.env.example`](./apps/api/.env.example) 配置 API 监听地址、Core SQLite 和 HTTP Source Store SQLite。
- [`apps/web/.env.example`](./apps/web/.env.example) 配置 Web 使用的 API 地址。

Core 与 Source Store 的 SQLite URL 可以指向不同文件，也可以指向同一个文件。Core 迁移拥有 `core_migrations`，HTTP Source Store 迁移拥有 `source_store_migrations`；共享文件时仍保持 Schema 所有权边界。

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Project Boundaries

- `core/src/domain`: 纯领域模型与规则，不依赖 HTTP、SQLite、SillyTavern 或 LLM SDK。
- `core/src/application`: 用例、应用编排及其 Ports；与 Domain 同属一个 Core 包。
- `apps/api`: HTTP Adapter、Source Store 持久化、运行状态探测、API 组合和迁移命令。
- `apps/web`: React 实验界面，只通过 HTTP API 访问系统，并在自身 API client 边界维护传输契约。
- `packages/core-sqlite`: Core Memory 持久化 Adapter、迁移和其他 Adapter 可复用的 SQLite 基础工具。
- `packages/shared`: ESLint 和 Prettier 的共享配置。
