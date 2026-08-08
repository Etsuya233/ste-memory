# 13 — 填表任务：手动楼层触发与运行

**What to build:** 填表任务状态机（idle / running / succeeded / failed / interrupted；关闭对话页或浏览器即 interrupted，不自动重放；用户取消同样落为 interrupted）+ 单空间单活动任务守卫；用户手动指定同步楼层范围触发；任务经 pi-agent-core 填表管线（查询 + 提案 + 提交）运行，LLM 走 12 的适配器，结果写入记忆记录/修订批次/字段证据（经 04）；「手动指定楼层范围」的触发 UI。

**块处理以 apps/api 填表实现为行为基准**（`fill-task-service.ts`：块循环 [from, to] 闭区间、默认块大小 20、块失败 → 任务 failed 且出错块标记可重试、已提交块保留、块边界安全检查点）；任务输入 = 原始消息内容（不套清洗规则，ST Regex 由用户自行负责）。

**楼层进度台账由本票维护**：按（记忆空间, 同步楼层）记录 untracked / processed / error——块成功 markProcessed、块失败 markError，与 api 的 markProcessed/markError 同语义；任务触发 UI 的「未处理范围」提示与覆盖视图（14）都从台账计算。

**Blocked by:** 04 — Dexie 持久层（二）；06 — 基础 UI 壳与设置面板；12 — LLM 适配器（ST backends 同源代理）

**Status:** ready-for-agent

- [ ] 手动选楼层范围触发；状态按 running → succeeded/failed 推进正确
- [ ] 中断语义生效（重开页面后标记 interrupted，不自动重放）
- [ ] 单空间单活动任务守卫；失败原因可读
- [ ] 手动验收：真实 ST + 真实 LLM 完成一次填表，记录/修订/证据落库可见
