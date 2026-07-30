# STR-MEMORY

本仓库用于构建 SillyTavern 长对话记忆的本地实验工具。当前提供纯逻辑 Core、HTTP API 与 React Web，并支持上传 SillyTavern JSONL 创建记忆空间、浏览原始聊天及管理空间；API 使用 Kysely 与 better-sqlite3 持久化应用数据。

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

- [`apps/api/.env.example`](./apps/api/.env.example) 配置 API 监听地址和应用 SQLite 数据库。
- [`apps/web/.env.example`](./apps/web/.env.example) 配置 Web 使用的 API 地址。

`DATABASE_URL` 指向唯一的应用数据库文件。Schema、Kysely 迁移、连接生命周期和 SQLite Adapter 均由 API 宿主管理；Memory 业务模块只保留领域模型、应用用例及其 Ports。迁移通过 `pnpm web:migrate` 显式执行。

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Project Boundaries

- `core/src/memory`: 当前唯一的业务模块，内部按 Domain、Application、inbound Ports 和 outbound Ports 组织，不依赖 HTTP、SQLite、SillyTavern 或 LLM SDK。
- `apps/api/src/application`: API 宿主专属流程和 Ports，例如来源聊天导入、系统表安装和运行状态查询。
- `apps/api/src/adapters/inbound`: HTTP 路由、SillyTavern JSONL 解析等驱动 Adapter。
- `apps/api/src/adapters/outbound`: SQLite 持久化、Source Store、数据库生命周期和健康检查等被驱动 Adapter。
- `apps/api/src/main.ts`: API Composition Root，只负责配置读取、Adapter 构造、业务模块装配和宿主启动。
- `apps/web`: React 实验界面，只通过 HTTP API 访问系统，并在自身 API client 边界维护传输契约。
- `packages/tools`: 与平台无关的通用接口，目前包含异步 `UnitOfWork`。
- `packages/shared`: ESLint 和 Prettier 的共享配置。
