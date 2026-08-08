# 07 — 手动导出/导入

**What to build:** 数据库 ↔ JSON 的序列化编解码（每记忆空间一个序列化单元，导出为全库单文件）；设置面板导出（下载 JSON 文件）/ 导入（上传并恢复）入口；导入前校验（结构/版本不匹配给出明确错误）；编解码纯函数测试。

**设计决策（2026-08，与 @ste-memory/core 分层对齐）：**

- 编解码模块放 **core**（`core/src/memory/export/`）：备份格式序列化的对象全部是 core 领域类型，api/web 与 st-extension 必须共享同一份格式定义，避免两处实现导致格式漂移、备份不兼容；Issue 08（R2 云同步）复用同一套序列化。
  - 放 core 的：TypeBox schema（core 已依赖 typebox）+ 纯函数 encode/decode + format/version 校验（复用 `DomainError`，报「文件版本不支持」）。
  - 不进 core 的：读取全库快照走 **port**（类似现有 repository port，由 st 的 Dexie 与 api 的 SQLite 各自实现，I/O 留在平台）；文件下载/上传 UI 与设置项留在平台（st 的 `plugin-settings` 等）。
- 信封 `appVersion` 是应用版本（不是 core 版本）。
- 若「备份文件」成为正式概念，按懒创建原则在 `core/CONTEXT.md` 补充术语。

**Blocked by:** 03 — Dexie 持久层（一）；04 — Dexie 持久层（二）；06 — 基础 UI 壳与设置面板

**Status:** resolved

- [x] 导出文件可完整恢复（导出→导入→数据一致，含记录/修订/证据）
- [x] 损坏或不匹配文件导入时报错提示，不产生半导入状态
- [x] 编解码为纯函数并有往返/错误测试
- [x] 文件信封：`{ format: "ste-memory-backup", version: 1, exportedAt, appVersion, data }`；导入先校验 format/version，未知版本给出明确错误（「文件版本不支持」），绝不产生半导入状态
- [x] 编解码位于 `core/src/memory/export/`，经导出 port 读取全库快照（st 用 Dexie 实现），core 不含任何 I/O

## Answer

提交 `aaa46b6`（22 文件，+1379/-20）。

- **core 编解码（`core/src/memory/export/`，纯函数，ADR 0021）**：`createBackupFile` / `decodeBackupFile` / `serializeBackupFile` / `parseBackupFile` + `validateBackupData`。信封 `{ format: "ste-memory-backup", version: 1, exportedAt, appVersion, data }`（appVersion 为应用版本）；导入先校验 format（「不是本插件的备份文件」）→ version（未知版本报「文件版本不支持」；缺失 version 信息不出现 undefined）→ TypeBox 结构校验（`memoryBackupFileSchema`，错误带路径如 `data.spaces[0].records[0].payload`）→ 完整性校验（空间/表格/字段/记录/历史/证据 id 全局唯一；实体归属一致；字段/记录/历史指向单元内表格；引用字段目标表在单元内；记录 payload 与字段证据键必须是其表格字段；字段证据引用的证据必须存在于单元）。错误全部走 `DomainError`（新增 `memory_backup_invalid_json` / `memory_backup_format_invalid` / `memory_backup_version_unsupported`，api 错误映射同步补齐）。
- **备份存储端口（core）**：`MemoryBackupRepository { loadSnapshot, restoreSnapshot }`，载荷 `MemoryBackupSnapshot`（= 备份文件 data 部分）；core 不含任何 I/O。
- **st-extension Dexie 实现（`db/memory-backup-repository.ts`）**：`loadSnapshot` 读六张表、证据行还原领域对象、按空间分组、id 排序确定；`restoreSnapshot` 六表清空 + 按单元批量写入，全包单事务——任一步失败整体回滚（测试验证撞主键时数据库与导入前完全一致，无半导入残留）。证据行↔领域对象转换收进共享 helper（`db/evidence-conversion.ts`，记录 repository 与备份 repository 共用，保留「快照证据缺少正文」损坏护栏）。
- **UI（设置面板「数据备份」组）**：导出 = 快照 → 信封 → 下载 `ste-memory-backup-<日期>.json`（Blob + object URL）；导入 = 文件读取 → `parseBackupFile` 校验（失败 toastr 报错不碰库）→ `confirm` 告知将替换全部数据 → `restoreSnapshot` 原子整体替换 → 成功提示 + 表格列表重取（`dataVersion` 状态）+ `syncToCurrentChat` 恢复当前对话绑定。
- **测试（全仓 424/424 绿，typecheck/lint/build 绿）**：core 编解码 20 例（信封/结构/完整性/往返/JSON 层/错误信息）；Dexie 备份 repository 6 例（分组/领域对象还原/多空间/全链路导出→导入→数据一致/整体替换/原子回滚）；UI 冒烟 9 例（含备份组按钮与文件输入投影）。架构测试放行 typebox 于 export 模块（注释说明，agent 子层限制不变）。
- **文档同步**：`core/CONTEXT.md` 新增术语「备份文件」；ADR 0021；`verify-ui-shell.mjs` 设置 Tab 新增备份入口断言（真机验收待跑）。
- **遗留**：api 的 SQLite 备份 port 实现与导出/导入 HTTP 入口未做（验收清单只要求 st 的 Dexie，api 侧随 ticket 08 云同步或后续票接入）；`loadSnapshot` 为 O(空间×行) 的数组过滤，规模增长时再优化。

## Comments

- 2026-08-08 code-review（双轴并行）结论：Standards 无硬违规（判断级：证据转换与记录 repository 重复——已采纳，抽共享 helper 并补齐损坏护栏；`validateBackupData` 四实体重复同形状——规模小不抽）。Spec 无 blocker；采纳修复：①缺失 version 时「文件 vundefined」信息修正；②完整性校验加深——记录 payload / 字段证据键必须是其表格字段、字段证据引用的证据必须存在（「不匹配文件」全量拦截）；③api 错误映射补三个备份错误。未采纳（判断级）：`history.recordId` 指向已删记录属合法（修订批次归档旧状态），不做存在性校验；`Value.Check` 允许额外键（同版本内 JSON 演进宽容，导入时忽略）。
