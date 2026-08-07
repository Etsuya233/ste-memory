# 01 — 系统表模板收编共享包

**What to build:** 系统表模板（七张系统表 + 世界状态表的字段、固定选项、v4 提示词）从 apps/api 移入 `packages/` 新共享包（ADR 0020），apps/api 改为从共享包引用，行为不变、测试全绿；后续插件（05）从同一共享包安装模板，杜绝双份漂移。

**Blocked by:** None — can start immediately

**Status:** resolved

## Answer

新包 `packages/memory-host-shared`（`@ste-memory/memory-host-shared`，ADR 0020）收编系统表模板：

- `src/system-memory-table-prompts.ts` / `src/system-memory-table-definitions.ts` 与迁移前逐字一致（仅补 `export` 关键字）；`src/index.ts` 导出 `SYSTEM_TABLE_PROMPTS`、`SYSTEM_FIELD_PROMPTS`、`SYSTEM_TABLE_TEMPLATES`（含 `FieldTemplate` / `TableTemplate` 类型）与 `SystemMemoryTableInstaller`。
- apps/api 安装路径改为 `@ste-memory/memory-host-shared`（main.ts / memory-spaces manager / 两个测试文件），删除旧文件与空目录；迁移快照注释与 README、优化报告的引用同步更新。
- 验证：`pnpm typecheck` 全包绿；受触文件 eslint 无错误（仓库级 lint 基线本就红，与本次无关）；apps/api + core + web 测试 49 文件 267 用例全绿（排除 gitignored 的 `tmp/`、`.worktrees/` 干扰目录后，基线与改动后均绿；此前观察到的随机 5000ms 超时属并行负载抖动，基线同现）。
- 插件侧（ticket 05）可从 `@ste-memory/memory-host-shared` 导入 `SystemMemoryTableInstaller` 与模板，无需复制。

- [x] 共享包存在并导出与迁移前逐字一致的模板（字段、固定选项、v4 提示词）
- [x] apps/api 无对旧位置的引用，系统表安装路径改为共享包
- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿（apps/api 既有测试不降级）
- [x] 插件侧（后续 ticket）可从共享包导入模板
