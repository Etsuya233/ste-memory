# STR-MEMORY

本仓库用于构建 SillyTavern 长对话记忆的本地实验工具。当前骨架提供纯领域包、应用包、Core SQLite Adapter、HTTP API 与 React Web；表格与对话处理功能将在后续工单中加入。

## Prerequisites

- Node.js 24 或更高版本
- npm 11 或更高版本

## Start Locally

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

API 默认运行在 `http://127.0.0.1:3000`，Web 默认运行在 `http://127.0.0.1:5173`。Web 首屏显示 HTTP API、Core SQLite 和 HTTP Source Store SQLite 的连接状态。

默认 API 只监听 `127.0.0.1`，用于本机单用户实验，当前版本不提供认证。

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_HOST` | `127.0.0.1` | API listening host |
| `API_PORT` | `3000` | API listening port |
| `CORE_DATABASE_URL` | `sqlite:./data/core.sqlite` | Core Memory database |
| `SOURCE_STORE_DATABASE_URL` | `sqlite:./data/source-store.sqlite` | HTTP Adapter Source Store database |
| `VITE_API_URL` | `http://127.0.0.1:3000` | Web API endpoint |

The two SQLite URL values may point at different files or the same file. Core migrations own `core_migrations`; HTTP Source Store migrations own `source_store_migrations`, so their schema ownership remains separate when a file is shared.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## Package Boundaries

- `packages/domain`: pure domain vocabulary and rules. It does not depend on HTTP, SQLite, SillyTavern, or LLM SDKs.
- `packages/application`: use-case contracts and ports, depending only on Domain as the model grows.
- `packages/core-sqlite`: Core Memory persistence adapter and its migrations.
- `apps/api`: HTTP adapter, Source Store persistence adapter, API composition, and API migrations.
- `apps/web`: React experiment UI, consuming the HTTP API only.
