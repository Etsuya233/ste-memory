# 03 — Dexie 持久层（一）：空间/表格/字段 repository

**What to build:** Dexie（IndexedDB）数据库 schema 与 core 端口的 repository 实现：记忆空间、记忆表格（定义与启停）、字段定义（12 种类型、必填、固定选项、Prompt、启停、顺序、引用目标）的读写；空间内隔离、定义 Key 唯一性、字段类型创建后不可变等规则与 core 一致；用 fake-indexeddb 在 Node 环境验证满足 core 端口契约。

**Blocked by:** 02 — 插件工程骨架与构建链

**Status:** ready-for-agent

- [ ] Dexie schema 就位，repository 实现空间/表格/字段的 CRUD 与启停
- [ ] 表格/字段定义按记忆空间隔离，跨空间互不可见
- [ ] 字段类型不可变、定义 Key 空间内唯一等 core 规则被满足
- [ ] fake-indexeddb 测试覆盖，语义与 core/api 既有测试一致
