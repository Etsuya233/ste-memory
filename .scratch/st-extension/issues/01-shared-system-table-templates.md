# 01 — 系统表模板收编共享包

**What to build:** 系统表模板（七张系统表 + 世界状态表的字段、固定选项、v4 提示词）从 apps/api 移入 `packages/` 新共享包（ADR 0020），apps/api 改为从共享包引用，行为不变、测试全绿；后续插件（05）从同一共享包安装模板，杜绝双份漂移。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 共享包存在并导出与迁移前逐字一致的模板（字段、固定选项、v4 提示词）
- [ ] apps/api 无对旧位置的引用，系统表安装路径改为共享包
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿（apps/api 既有测试不降级）
- [ ] 插件侧（后续 ticket）可从共享包导入模板
