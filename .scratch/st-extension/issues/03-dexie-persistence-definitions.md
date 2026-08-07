# 03 — Dexie 持久层（一）：空间/表格/字段 repository

**What to build:** Dexie（IndexedDB）数据库 schema 与 core 端口的 repository 实现：记忆空间、记忆表格（定义与启停）、字段定义（12 种类型、必填、固定选项、Prompt、启停、顺序、引用目标）的读写；空间内隔离、定义 Key 唯一性、字段类型创建后不可变等规则与 core 一致；用 fake-indexeddb 在 Node 环境验证满足 core 端口契约。

**Blocked by:** 02 — 插件工程骨架与构建链

**Status:** resolved

- [x] Dexie schema 就位，repository 实现空间/表格/字段的 CRUD 与启停
- [x] 表格/字段定义按记忆空间隔离，跨空间互不可见
- [x] 字段类型不可变、定义 Key 空间内唯一等 core 规则被满足
- [x] fake-indexeddb 测试覆盖，语义与 core/api 既有测试一致

## Answer

新包 `apps/st-extension/src/db/` 落地 Dexie 持久层（ADR 0002），四个验收项全部闭环：

- **Schema（`database.ts`）**：`SteMemoryDatabase extends Dexie`，v1 三张表——`memorySpaces` / `memoryTables` / `memoryFields`。实体按领域对象原样存储（IndexedDB 原生支持数组/对象，无需像 SQLite 参照实现那样把 options / displayStrategy JSON 字符串化，ticket 07/08 导出与云同步直接序列化行即可）。复合唯一索引 `&[memorySpaceId+key]`（表内）与 `&[memorySpaceId+tableId+key]`（字段）在数据库层兜底「定义 Key 空间内唯一」；跨空间隔离靠所有查询携带 memorySpaceId 作用域 + 索引实现。**dexie 导入**：TS6 NodeNext 下默认导入 `import Dexie from "dexie"` 会被类型化为不可构造的模块命名空间（TS2507，开 esModuleInterop 也无效）；改用 Dexie 4.4.4 的**具名导出** `import { Dexie, type Table } from "dexie"`——类型与运行时一致（bundle 后 Node + fake-indexeddb 运行时验证：同一构造器，读写/复合索引/删除全部通过）。
- **Repository（三个文件）**：`DexieMemorySpaceRepository` / `DexieMemoryTableRepository` / `DexieMemoryFieldRepository`，逐一实现 core 端口（`@ste-memory/core/memory/adapter`）全部方法，语义对照 `apps/api` 的 Kysely 参照实现：
  - 作用域规则：find/delete/update 以「id 命中 + 空间（及表格）匹配」为准，跨空间/跨表一律未命中（false/undefined）；
  - 排序同参照：空间 createdAt 倒序、表格 createdAt 升序、字段 position 升序（id 兜底保证确定性）；
  - 更新只写可变字段（同参照的 `.set()` 列表），createdAt 创建事实不覆盖；
  - **删除级联**（同参照 `ON DELETE CASCADE`）：删空间连带删其表格与字段，删表格连带删其字段，均在单事务内完成；
  - 启停 = 服务的 update({enabled}) 走通（含停用必填字段的 warnings 语义）。
- **core 规则验证（服务层，错误 type 与 api 既有测试逐一对应）**：表格 Key 空间内冲突 `memory_table_key_conflict`；字段 Key 表内冲突 `memory_field_key_conflict`；字段类型不可变 `memory_field_type_immutable`；引用目标必须在本空间 `memory_field_reference_table_invalid`；单选/多选选项非空且不重复 `memory_field_options_invalid`；maxChars 正整数 `memory_field_max_chars_invalid`；显示策略依赖字段禁删/禁停用 `memory_field_used_by_display_strategy`。
- **测试（fake-indexeddb，行为级）**：`test-support.ts` 提供互不冲突的测试库（afterEach 统一删除）+ `createServices`（三个 Dexie repo 接 core 服务，id 自增、时钟可注入，同 api `createTestApplication` 形态）。4 个测试文件 37 用例全绿：
  - 空间：CRUD/重命名/列表倒序/删除级联/**关库重开数据仍在（页面刷新语义）**；
  - 表格：CRUD 与启停、跨空间隔离（同 Key 异空间共存、跨空间操作未命中）、Key 冲突规则、重命名 Key、创建时间排序、缺空间返回 undefined；
  - 字段：全配置 CRUD（options/引用/maxChars/valuePattern）、跨空间/跨表隔离（同表内 Key 唯一、异表同 Key 合法）、类型不可变、引用目标规则、选项/长度校验、显示策略保护、停用必填字段警告、position 排序；
  - 系统表安装（对照 `apps/api/test/system-memory-tables.test.ts` 语义）：8 张系统表 + 字段/引用/显示策略正确，双空间安装互不串扰（同 Key 异 id、引用指向各自空间内表）。
- **验证**：包内 test 37/37 绿，typecheck（src + scripts 双 tsconfig）绿，lint 0 问题；esbuild 单文件 bundle 实测 dexie 打包干净（仅 dexie 进 node_modules 输入，bundle 259KB，无裸 import），bundle 在 Node + fake-indexeddb 下真实读写（含复合唯一索引）通过；全仓 vitest（排除 tmp/.worktrees）304/304 绿（含本包 4 个新测试文件；chat.test.ts 2 例失败为既知并行负载抖动，单跑与复跑均绿）；全仓 typecheck/lint 绿。
- 依赖：`dexie@^4.4.4`、`@ste-memory/core`、`@ste-memory/memory-host-shared`（workspace）加入包依赖。

## Comments

- 2026-08-08 code-review（双轴并行）结论：Standards 无硬违规（仅判断级：三 repo 的 scoped 守卫/排序块重复——与参照实现同构、端口契约固有）。Spec 无 blocker、无缺失；采纳两条修复：①删除级联（SQLite 参照有 `ON DELETE CASCADE`，Dexie 原实现会孤儿化表格/字段，泄漏进未来导出/云同步）——空间/表格删除改为单事务级联，并补两条级联测试；②update 只写可变字段，不再整体覆盖 createdAt。
- 2026-08-08 Codex 分析采纳：类型桥（`DexieModule as unknown as typeof DexieModule.default`）是多余 workaround——Dexie 4.4.4 的**具名导出** `import { Dexie } from "dexie"` 类型与运行时一致（完整工程 typecheck / esbuild bundle / Node ESM 运行时均验证通过），已删除类型桥与整段兼容说明；`module: Preserve` 等替代方案因影响面大未采纳。Codex 另指出旧注释「类本身没有 `.default` 属性」不准确（Dexie 构造器实际带指向自身的静态 `.default`）——随类型桥删除已不存在。
- 遗留记录：spec.md 多处写「七张系统表」，而共享模板（ADR 0020 单一事实源）与 api 测试均为 8 张（含 story_state）——既有措辞漂移，非本 ticket 引入，未改 spec（开工规则），留待后续统一。
- 后续 ticket 注意：fake-indexeddb 必须在 dexie 模块求值前装好全局 indexedDB（dexie 模块加载时捕获全局）——测试文件若直接 import `./database.ts`，须先 import `test-support.ts`（已有注释说明）；本包无 vitest config，与全仓零配置约定一致。
