# ST 插件架构收敛重构进度

状态：代码重构与 Review 修复已完成，真实 ST 验收待执行。范围与阶段定义见 `docs/refactor-plan.md`。

## 阶段 A：基线与迁移清单

### 环境

- 分支：`refactor/st-plugin-architecture`（起点 `c53f662`，代码基线 `d457694`）。
- Node v24.14.0 / pnpm 11.17.0（Corepack 拉取，`mise.toml` 约定不变）。
- 依赖：`pnpm install --frozen-lockfile` 成功（better-sqlite3 需本机编译，已通过）。
- 全部检查与测试在同一工作区执行，未改动 `main`。

### 基线检查结果（2026-10-17，重构前）

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | 7 个 workspace 包全部通过 |
| `pnpm lint` | 失败（65 errors） | 4 个 `docs/playwright-st-extension/*.mjs` 验收脚本（browser 全局 `no-undef`）+ `apps/st-extension/src/macros/memory-view-render.test.ts`（未使用变量） |
| `pnpm format:check` | 失败（89 files） | 覆盖 api/web/core/插件/脚本/lockfile 的历史未格式化文件 |
| `pnpm test` | 通过 | 138 test files / 1387 tests，84s |
| `pnpm build` | 通过 | api/web 构建 + 插件 esbuild 打包（dist/index.js 1.2mb） |

基线失败项均为重构前既有问题，不计入本次重构引入。

### 广播依赖与删除项清单

- R2 云同步：`apps/st-extension/src/cloud/*`（R2 适配器、S3 签名、协调器、指纹）、`core/src/memory/cloud/*`（云文件协议与 `resolveCloudLww`）、设置中的 `r2` 字段与面板分组、状态文案与样式、相关测试。
- 共用能力需先迁出：`SpaceFingerprint`/`SyncChangeSource` → Memory 变更检测；`DexieSyncChangeSource` → IndexedDB 实现；`SyncTimerPort`/`PollingEvaluator` → common；`resolveCloudLww` 的镜像用途 → 聊天镜像本地比较。
- API/Web 宿主：`apps/api`（含 Kysely/SQLite 迁移与 seed 脚本）、`apps/web`、`packages/tools`（`UnitOfWork` 仅 API 使用）、SQLite 专属测试与命令。
- 系统表模板：`packages/memory-host-shared` → Memory `system-tables`。
- 旧路径脚本：`apps/st-extension/scripts/*`、`scripts/release-st.mjs`、`scripts/seed/*`。

## 阶段 B：拆除 R2 Sync

已完成：

- 共用能力先迁出，再删除 R2：
  - 空间变更指纹与变更来源：`cloud/space-fingerprint.ts` + `db/dexie-sync-change-source.ts` 合并为 `db/memory-change-source.ts`（`MemoryChangeFingerprint` / `MemoryChangeSource` / `memoryChangesEqual` / `DexieMemoryChangeSource`，去掉云同步命名），镜像、记忆宏、Agent 预设宏共用。
  - 定时器端口与轮询骨架：`SyncTimerPort` → `common/timers.ts` 的 `TimerPort`；`polling-evaluator.ts` → `common/polling-evaluator.ts`。
  - 聊天镜像的 LWW：由 `core` 的 `resolveCloudLww` 改为镜像本地的 `compareMirrorUpdatedAt`（时间戳无法解析按 equal 保守不覆盖，语义不变）。
- 删除：插件 `cloud/*`（R2 适配器、S3 SigV4 签名、同步协调器、cloud 出口）、`core/src/memory/cloud/*`（云文件/索引协议与编解码）、`core/test/memory-cloud-codec.test.ts`、插件 `docs/r2-cloud-sync.md`。
- 设置：`PluginSettings.r2` / `DEFAULT_SETTINGS.r2` / `mergeR2` / `isR2Configured` 全部移除；`StSettingsStore` 写回 `extensionSettings[SETTINGS_KEY] = settings` 为整体替换，旧 `r2` 字段在下一次保存时随写回对象消失（新增测试断言读取结果不含 `r2`，其他字段保留）。
- 界面：面板头部同步状态、设置「云同步（Cloudflare R2）」分组（4 输入/状态/最近同步/立即同步按钮）、`stm-sync-error` 样式移除；危险操作确认文案改为只提对话文件镜像。验收脚本 `verify-ui-shell.mjs` 同步移除 R2 断言。
- 运行时：`SteMemoryRuntime.sync` 与启动拉取移除；镜像启动不再等待云拉取。
- 文档：ADR 0022 标记「已废弃（被取代）」，ADR 0023 与 `chat-metadata-mirror.md` 去掉 R2 依赖表述，`CONTEXT.md` 的「云同步」条目改为已移除说明。

验证（阶段 B 后）：`apps/st-extension` 79 files / 970 tests 通过；`core` 25 files / 209 tests 通过；插件 `tsc` 通过。

## 阶段 C：收敛单包与路径迁移

已完成：

- 源码收敛到根 `src/`：
  - `core/src/memory/domain|application|export|chat-mirror|cloud` → `src/features/memory`、
    `src/features/agent`、`src/features/backup`、`src/features/chat-mirror`（cloud 已删）；
  - `apps/st-extension/src/*` → `src/features/*`（fill-tasks / query-chat / macros / agent-presets /
    chat-binding / space-maintenance / settings / cleaning / logging）、`src/infrastructure/indexeddb|sillytavern`、
    `src/ui`、`src/common`；入口保留 `src/index.ts` / `bootstrap.ts` / `runtime.ts`；
  - `packages/memory-host-shared` → `src/features/memory/system-tables`；
  - 核心测试按目标归属就地迁移（共置 `.test.ts`），架构测试改到 `tests/architecture`，
    IndexedDB 集成测试改到 `tests/integration`。
- 删除：`apps/api`、`apps/web`、`packages/tools`、`packages/shared`（eslint/prettier 配置内联根目录）、
  SQLite 迁移、JSONL 解析、HTTP/SSE、seed 脚本（`scripts/seed/*`）及其测试（共 34 个测试文件）。
- 工程配置合并为单包：`package.json`（沿用插件版本 0.1.3，依赖并入根）、`tsconfig.json`、
  `vitest.config.ts`、`eslint.config.js`、`prettier.config.js`、`.prettierignore`；
  `pnpm-workspace.yaml` 只保留 `allowBuilds`（无包列表）；`manifest.json`、`.env.example` 移到根。
- 构建/同步/发布路径更新：`scripts/build-lib.ts`（入口 `src/index.ts`）、`dev.ts`（watch 样式源）、
  `sync.ts`、`release-st.mjs`（版本源 = 根 `package.json`，产物 = 根 `dist/`）。
- 根命令：`dev` / `build` / `sync` / `deploy:st` / `typecheck` / `lint` / `format:check` / `test` / `release:st`。

验证（阶段 C 后）：`npx tsc -p tsconfig.json` 0 错误（测试文件首次纳入类型检查，修正历史夹具漂移）；
`pnpm lint`、`pnpm format:check` 全绿；`pnpm test` 104 files / 1172 tests 通过；`pnpm build` 产物形状不变。

## 阶段 D：业务归位与入口收敛

- `features/memory` 重排：`space-service` / `table-service` / `field-service` / `record-query` /
  `record-writer`，内部步骤（`record-mutations` / `record-display` / `record-validation` /
  `proposal-*`）收进 `internal/`，仓库端口收进 `ports/`；公开入口 `features/memory/index.ts`。
- 提交细节收归 Memory：新增 `createMemoryCommitContext`（id 工厂、时钟、显示文本计算），
  runtime 不再拼提交上下文，填表/问答/手动编辑共用同一份写入规则。
- 只读端口 `MemorySpaceReader` 从 agent 目录移入 `features/memory/ports`，Agent/宏/填表/问答
  统一从 Memory 入口导入。
- `packages/tools` 的 `UnitOfWork`、`application/ports/inbound.ts` 的 `*UseCases` 接口等
  无消费者抽象删除；`proposal-agent.ts`（API 专属装配）删除，契约测试迁移到保留实现
  `runFillAgent`（`agent-run-contract.test.ts` + `proposal-workflow.test.ts`）。
- 入口约束自动化：
  - ESLint `no-restricted-imports`：其他位置不得引用 `features/memory/**`（`index.ts` 例外）、
    功能层不得引用 `infrastructure/**` 与 `ui/**`；
  - `tests/architecture/memory-boundaries.test.ts`：Domain 无外层依赖、Memory 入口唯一、
    功能层无基础设施/UI 依赖、Memory 不反向依赖其他功能；
  - 修复过程中真实拦截了 agent/backup/infrastructure 对 Memory 内部路径的直连。
- 清理共享抽象重复与注释里的旧宿主引用（apps/api、core、@ste-memory 等）。

## 阶段 E：拆分 UI 热点与整理运行时

- `panel-shell.tsx` 2605 行 → `ui/shell/panel-shell.tsx`（外壳：窗口/安全区/入口几何、Tab 导航、
  状态订阅、分支弹窗）+ `ui/memory/tables-tab.tsx` + `ui/settings/settings-tab.tsx`（含
  `MacroSettingsFields`）。
- UI 目录按职责重组：`ui/shell`、`ui/memory`、`ui/tasks`、`ui/query-chat`、`ui/logs`、`ui/settings`；
  `ui/index.ts` 死导出中转删除，bootstrap 直接引用 `mountPanel`。
- 业务编排回到功能：
  - `features/fill-tasks/prompt-context.ts`：预设解析 + 世界书扫描 + 快照拼装；
  - `features/agent-presets/preset-preview-ports.ts`：预览端口装配；
  - `features/macros/macro-overview.ts`：宏内容一览读取器；
  - `features/backup/space-transfer.ts`：单空间导出单元、文件名与全库导入 plan/execute；
  - `features/chat-binding/space-import.ts`：单空间导入的 plan/execute（面板只做文件选择、
    确认弹窗与提示）；
  - `infrastructure/browser/download.ts`：浏览器下载。
- 样式按界面职责拆成 `src/ui/styles/*.css`（10 个文件，原 3112 行），构建时按固定顺序聚合为
  `dist/style.css`；`dev.ts` watch manifest 与全部样式源（样式改动重新聚合后同步）。
- DOM 契约保持：`data-action` / `data-stm-field` / `data-group` / 类名不变，验收脚本仅同步删除
  R2 相关断言。

## 阶段 F：文档、验证与交付

- README 重写（插件用途、根命令、`.env` 配置、产物、验证、发布）；
  `CONTEXT-MAP.md` 改为单上下文；`AGENTS.md`、`docs/agents/domain.md` 更新；
  core/插件词汇表合并为根 `CONTEXT.md`（历史副本已清理）。
- ADR 0022 标记「已废弃（被取代）」；0014/0015/0017/0020 标记废弃或部分废弃，0024 标注装配迁移；
  0008/0018/0021 标注路径更新；`docs/db-optimization-report.md` 标记历史归档。
- 插件文档迁移：`apps/st-extension/docs/adr/*` → `docs/adr/st/*`，
  `chat-metadata-mirror.md` → `docs/chat-metadata-mirror.md`。

### 首轮重构检查（Review 修复前）

| 检查 | 结果 | 与基线对比 |
| --- | --- | --- |
| `pnpm typecheck` | 通过（0 错误） | 基线通过；覆盖范围扩大到全部源码与测试 |
| `pnpm lint` | 通过 | 基线 65 errors（docs 验收脚本 + 未使用变量）→ 0 |
| `pnpm format:check` | 通过 | 基线 89 files 未格式化 → 0 |
| `pnpm test` | 通过：104 files / 1172 tests | 基线 138 files / 1387 tests（删除 API/Web/云同步测试 34 个） |
| `pnpm build` | 通过：`dist/index.js` + `manifest.json` + `style.css` | 与基线产物形状一致（单文件 bundle 1.2mb） |

行为验证补充：

- 新增「台账标记失败 → 记录/历史/证据同事务回滚」测试（`fill-task-service.test.ts`），
  证明批次提交与台账仍在一个 Dexie 事务内。
- 备份/镜像/数据库兼容：`ST_MEMORY_DB_NAME`、Dexie 版本历史、`BACKUP_FORMAT/VERSION`、
  `CHAT_MIRROR_FORMAT/VERSION`、chatMetadata 键（`steMemory` / `steMemoryMirror` /
  `steMemoryCleaningList` / `steMemoryChatMacros`）、`extension_settings.steMemory` 均未改动；
  聚合后的 `style.css` 与原文件选择器集合除已删除的 `.stm-sync-error` 外完全一致。

真实 ST 验收：**未执行**（无隔离 ST 环境，且不向用户 ST 安装目录写入）。验收方式为
单元/集成测试 + 构建产物检查 + 验收脚本路径审查；`docs/playwright-st-extension/*` 中的
选择器断言已随界面改动同步（删除 R2 断言）。

### 剩余工作

- 真机（隔离 SillyTavern）验收插件加载、空间绑定、编辑、填表、取消、问答、宏、备份与镜像。
- `pnpm release:st --dry-run` 未执行（会写入 `.worktrees/release` 并可能联网）。

## Review 修复

首轮 Review 发现三项 P2，现已修复：

1. **边界检查**：合并 ESLint 中重叠的导入限制，避免后面的规则覆盖 Memory 限制。
   架构测试使用 TypeScript AST 与项目编译配置解析实际目标，覆盖相对路径、别名、
   重导出、仅副作用导入、字面量动态导入与类型导入；Domain 的技术包依赖会被拒绝。
   增加正反向回归用例，确保合法公开入口及 UI 自身的 memory 目录导入不会被误拦。
2. **提案提交**：已有 `MemoryRecordService` 增加 `commitProposal`，内部构造提交上下文。
   填表与问答只接收完整提交操作，不再接收仓库、ID、时钟及显示回调的上下文。
   公共入口移除上下文工厂、上下文类型及底层提案提交函数；内部测试直接测试内部实现。
   原有填表事务范围保持，台账失败时记录、历史、证据回滚测试继续通过。
3. **设置与 UI**：新增具体的 `SettingsService`，集中启停、镜像、宏设置、视图与对话宏
   保存后的联动，先保存设置再执行刷新，错误交回 UI 报告；启停会立即刷新两个宏及镜像。
   设置页、表格页改为局部依赖参数，不再依赖整份 `PanelRuntime`。
   新增服务测试，并让运行时集成测试通过设置服务验证宏改名、插件启停与视图刷新。

最终检查：

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm format:check` | 通过 |
| `pnpm test` | 105 个文件、1189 项全部通过 |
| `pnpm build` | 通过，产物仍为 index.js、manifest.json、style.css |

完整测试与独立构建顺序执行，避免并行编译干扰构建测试的 30 秒超时。
未执行真实 ST 验收、开发同步和发布，也未修改用户数据。
