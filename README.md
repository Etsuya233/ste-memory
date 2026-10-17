# STR-MEMORY

SillyTavern 长对话记忆插件的源码仓库：在对话文件之外维护可修订的「记忆表格」，
供角色卡与提示词预设通过宏注入当前认知，并支持手动编辑、Agent 填表、问答与
本地备份/镜像恢复。全部数据默认存在浏览器 IndexedDB 与对话文件（chatMetadata）
中，不依赖任何远端服务。

## Prerequisites

- [mise](https://mise.jdx.dev/)

项目通过 [`mise.toml`](./mise.toml) 固定 Node.js 与 pnpm 版本，不使用 Corepack。

## 开始

```bash
mise install
pnpm install
```

## 开发命令

```bash
pnpm dev          # esbuild watch + 同步到 ST 扩展目录（需 .env 配置）
pnpm build        # 产物写到 dist/：index.js / manifest.json / style.css
pnpm typecheck    # tsc -p tsconfig.json
pnpm lint         # eslint .
pnpm format:check # prettier --check .
pnpm test         # vitest run
```

真实 SillyTavern 验收脚本在 [`docs/playwright-st-extension`](./docs/playwright-st-extension)，
通过 `window.__STE_MEMORY_RUNTIME__`（调试入口）驱动面板与数据流。

## ST 安装与同步

`pnpm dev` / `pnpm sync` 会把 `dist/` 拷进 SillyTavern 的
`public/scripts/extensions/third-party/ste-memory`（**会写入 ST 安装目录**）。
目标位置从仓库根 `.env` 读取，二选一（参考 [`.env.example`](./.env.example)）：

- `STE_ST_EXTENSION_DIR`：直接指向扩展目标目录；
- `STE_ST_INSTALL`：SillyTavern 安装根目录，自动推导扩展子路径。

## 发布

`pnpm release:st` 重新生成 `release/sillytavern-plugin` 分支（构建产物分支，
SillyTavern 通过该分支安装/更新）。默认只更新本地分支，`--push` 才推送远端。

## 目录结构

```text
src/
├── index.ts / bootstrap.ts / runtime.ts   # 入口、ST 环境守卫、组合根
├── features/                              # 业务功能（直接函数/服务调用，无事件总线）
│   ├── memory/                            # 共享记忆模型与写入规则（唯一来源）+ 公开入口
│   ├── agent/                             # 提案/查询 Agent 运行与工具
│   ├── fill-tasks/  query-chat/  macros/  # 填表任务、问答面板、宏
│   ├── backup/  chat-mirror/              # 备份文件格式、镜像格式与导出辅助
│   └── settings/ cleaning/ chat-binding/ space-maintenance/ logging/ agent-presets/
├── infrastructure/                        # 具体实现：IndexedDB（Dexie）、SillyTavern 适配器、浏览器
├── ui/                                    # 面板 React 组件与纯逻辑模型（shell/memory/tasks/…）
└── common/                                # 跨功能的小工具（定时器端口、轮询骨架）
```

约束：

- 其他功能与 UI 只能通过 `src/features/memory/index.ts` 使用 Memory（领域类型、
  完整操作与持久化接口都在入口导出）；内部步骤（校验、修订、历史写入、显示文本
  计算）不对外暴露。
- 功能层不依赖 `infrastructure/` 与 `ui/`；具体实现由 `runtime.ts` 装配注入。
- `tests/architecture/` 与 ESLint `no-restricted-imports` 同时强制以上方向。

## 验证

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## 文档

- 领域与插件词汇：[`CONTEXT.md`](./CONTEXT.md)
- 结构决策：[`docs/adr`](./docs/adr)（插件决策在 `docs/adr/st`）
- 对话文件镜像格式：[`docs/chat-metadata-mirror.md`](./docs/chat-metadata-mirror.md)
- 记忆视图与记忆查询：[`docs/memory-views.md`](./docs/memory-views.md)
- 本轮架构收敛：[`docs/refactor-plan.md`](./docs/refactor-plan.md)、[`docs/refactor-progress.md`](./docs/refactor-progress.md)
