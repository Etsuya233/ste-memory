# 04 — Dexie 持久层（二）：记录/修订/证据 repository

**What to build:** 记忆记录、修订批次与历史记录、字段证据的 Dexie repository 实现：记录按字段定义校验存储、更新走修订批次（历史归档）、删除保护（被引用记录不可单独删除、引用字段目标校验）、字段证据（证据条目引用）读写；fake-indexeddb 测试与 core/api 同语义。

**Blocked by:** 03 — Dexie 持久层（一）：空间/表格/字段 repository

**Status:** ready-for-agent

- [ ] 记录创建/更新/删除与修订批次、历史记录归档行为正确
- [ ] 引用字段目标校验与删除保护生效
- [ ] 字段证据条目可写可读（同步楼层作来源 ID）
- [ ] fake-indexeddb 测试覆盖，语义与 core/api 既有测试一致
