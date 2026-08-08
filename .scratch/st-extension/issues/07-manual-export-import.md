# 07 — 手动导出/导入

**What to build:** 数据库 ↔ JSON 的序列化编解码（每记忆空间一个序列化单元，导出为全库单文件）；设置面板导出（下载 JSON 文件）/ 导入（上传并恢复）入口；导入前校验（结构/版本不匹配给出明确错误）；编解码纯函数测试。

**设计决策（2026-08，与 @ste-memory/core 分层对齐）：**

- 编解码模块放 **core**（`core/src/memory/export/`）：备份格式序列化的对象全部是 core 领域类型，api/web 与 st-extension 必须共享同一份格式定义，避免两处实现导致格式漂移、备份不兼容；Issue 08（R2 云同步）复用同一套序列化。
  - 放 core 的：TypeBox schema（core 已依赖 typebox）+ 纯函数 encode/decode + format/version 校验（复用 `DomainError`，报「文件版本不支持」）。
  - 不进 core 的：读取全库快照走 **port**（类似现有 repository port，由 st 的 Dexie 与 api 的 SQLite 各自实现，I/O 留在平台）；文件下载/上传 UI 与设置项留在平台（st 的 `plugin-settings` 等）。
- 信封 `appVersion` 是应用版本（不是 core 版本）。
- 若「备份文件」成为正式概念，按懒创建原则在 `core/CONTEXT.md` 补充术语。

**Blocked by:** 03 — Dexie 持久层（一）；04 — Dexie 持久层（二）；06 — 基础 UI 壳与设置面板

**Status:** ready-for-agent

- [ ] 导出文件可完整恢复（导出→导入→数据一致，含记录/修订/证据）
- [ ] 损坏或不匹配文件导入时报错提示，不产生半导入状态
- [ ] 编解码为纯函数并有往返/错误测试
- [ ] 文件信封：`{ format: "ste-memory-backup", version: 1, exportedAt, appVersion, data }`；导入先校验 format/version，未知版本给出明确错误（「文件版本不支持」），绝不产生半导入状态
- [ ] 编解码位于 `core/src/memory/export/`，经导出 port 读取全库快照（st 用 Dexie 实现），core 不含任何 I/O
