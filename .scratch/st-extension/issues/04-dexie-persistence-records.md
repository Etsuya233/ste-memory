# 04 — Dexie 持久层（二）：记录/修订/证据 repository

**What to build:** 记忆记录、修订批次与历史记录、字段证据的 Dexie repository 实现：记录按字段定义校验存储、更新走修订批次（历史归档）、删除保护（被引用记录不可单独删除、引用字段目标校验）、字段证据（证据条目引用）读写；fake-indexeddb 测试与 core/api 同语义。

**Blocked by:** 03 — Dexie 持久层（一）：空间/表格/字段 repository

**Status:** resolved

- [x] 记录创建/更新/删除与修订批次、历史记录归档行为正确
- [x] 引用字段目标校验与删除保护生效
- [x] 字段证据条目可写可读（同步楼层作来源 ID）
- [x] fake-indexeddb 测试覆盖，语义与 core/api 既有测试一致

## Answer

新 repository `apps/st-extension/src/db/memory-record-repository.ts` 落地记录/修订/证据持久层（ADR 0002），四个验收项全部闭环：

- **Schema（`database.ts` v2）**：新增三张表——`memoryRecords`（当前记录，payload/fieldEvidence/source 原样存储，revisionId 随行保存供乐观锁）、`memoryRecordHistory`（修订批次归档的旧状态快照，`[memorySpaceId+tableId+recordId]`/`[memorySpaceId+recordId]`/`memorySpaceId` 索引覆盖各类历史查询）、`memoryEvidence`（证据条目独立存储，`&[memorySpaceId+source_type+source_id]` 唯一索引兜底「同一来源身份只存一条证据」）。v1→v2 走 Dexie 版本升级，旧库无损升级（有专门升级测试）。
- **记录 repository（`DexieMemoryRecordRepository`）**：同时实现 `MemoryRecordRepository` + `MemoryEvidenceRepository` 两个 core 端口（同 Kysely 参照实现）。`create`/`commit` 把记录写入与证据写入包在同一读写事务（失败整批回滚，field-evidence 测试验证「冲突请求不残留孤儿证据」）；`commit` 乐观锁与参照同语义——replace 先归档历史快照，仅当当前行 revisionId 仍等于 previous 时写入/删除，否则回滚返回 false，core 服务层转成 `memory_record_revision_conflict`。作用域/排序/过滤与参照逐一对应：find 以 id+空间+表格全匹配为准；list createdAt 升序；listHistory 按最具体索引收敛 + 剩余条件内存过滤，archivedAt 倒序（id 兜底）。
- **删除级联扩展**：删空间连带清记录/历史/证据、删表格连带清记录/历史（证据只挂空间，同参照 FK 布局），单事务完成。
- **证据存储形态**：领域 `MemoryEvidence` 无空间字段（参照以列承载），Dexie 行以 `MemoryEvidenceRow` 包装（`evidence_id`→主键 `id` + 外挂 `memorySpaceId`），读写时转换；**踩坑记录**：索引键路径必须用领域属性名——`source_type`/`source_id` 是蛇形，写成 camelCase（`sourceType`/`sourceId`）时索引对不上行、永不命中（fake-indexeddb 下索引静默为空，无报错）。
- **测试（fake-indexeddb，行为级）**：`memory-record-repository.test.ts` 13 用例，对照 api `current-records.test.ts` + `field-evidence.test.ts` 语义：CRUD/分页搜索、修订批次归档 + 过期修订冲突、删除前完整快照归档、引用目标校验与删除保护（`memory_record_referenced` 带引用位置）、混合 create/update 批原子提交（临时 ID 解析、共享修订身份）、commit 乐观锁失败整批回滚、证据快照/引用写读 + 来源身份复用 + 存储模式冲突 + 无孤儿证据 + 历史归档保留旧证据、跨空间/跨表隔离、表格/空间删除级联、archivedAt 倒序、关库重开（页面刷新）、v1→v2 升级无损。
- **验证**：包内 test 50/50 绿（含新增 13 例），typecheck（src + scripts）与 lint 0 问题，esbuild bundle 构建通过；全仓 vitest（排除 tmp/.worktrees）317/317 绿（一次 1 例失败为既知并行负载抖动，复跑全绿），全仓 typecheck/lint 绿。

## Comments

- 2026-08-09 code-review（双轴并行）结论：Standards 无硬违规（仅判断级：space/table 删除级联块重复——与参照实现同构、端口契约固有，保留）；Spec 无 blocker、无缺失（小缺口：api 的无效输入类型错误用例未镜像——属 core 共享服务层逻辑，api 已覆盖）。采纳两条：①findEvidence 补快照证据缺正文的损坏检查（同参照）；②补 v1→v2 schema 升级测试与 listHistory 多条目 archivedAt 倒序断言（原为 reviewer 指出的残余风险）。
- 遗留记录：`findEvidence` 的类型转换 `as MemoryEvidence` 因条件展开无法收窄而保留显式断言（lint/typecheck 均认可）。
