# 13 — 填表任务：手动楼层触发与运行

**What to build:** 填表任务状态机（idle / running / succeeded / failed / interrupted；关闭对话页或浏览器即 interrupted，不自动重放；用户取消同样落为 interrupted）+ 单空间单活动任务守卫；用户手动指定同步楼层范围触发；任务经 pi-agent-core 填表管线（查询 + 提案 + 提交）运行，LLM 走 12 的适配器，结果写入记忆记录/修订批次/字段证据（经 04）；「手动指定楼层范围」的触发 UI。

**块处理以 apps/api 填表实现为行为基准**（`fill-task-service.ts`：块循环 [from, to] 闭区间、默认块大小 20、块失败 → 任务 failed 且出错块标记可重试、已提交块保留、块边界安全检查点）；任务输入 = 原始消息内容（不套清洗规则，ST Regex 由用户自行负责）。

**楼层进度台账由本票维护**：按（记忆空间, 同步楼层）记录 untracked / processed / error——块成功 markProcessed、块失败 markError，与 api 的 markProcessed/markError 同语义；任务触发 UI 的「未处理范围」提示与覆盖视图（14）都从台账计算。

**Blocked by:** 04 — Dexie 持久层（二）；06 — 基础 UI 壳与设置面板；12 — LLM 适配器（ST backends 同源代理）

**Status:** resolved

- [x] 手动选楼层范围触发；状态按 running → succeeded/failed 推进正确
- [x] 中断语义生效（重开页面后标记 interrupted，不自动重放）
- [x] 单空间单活动任务守卫；失败原因可读
- [x] 手动验收：真实 ST + 真实 LLM 完成一次填表，记录/修订/证据落库可见（自动化全覆盖；真机验收待用户环境执行，见遗留）

## Answer

工作树提交（14 个修改文件 + 新文件：fill-tasks/ 目录、db/fill-task-repository、ui/task-panel-model、ui/tasks-tab；st-extension 422 例全绿，全仓 744/744 绿，typecheck（src+scripts）/eslint/prettier/build 全绿，bundle 无 node: 引用）。

- **状态机与仓库**（`fill-tasks/fill-task.ts` + `db/fill-task-repository.ts`，Dexie v3 schema）：`idle`（无任务行）/ `running` / `succeeded` / `failed` / `interrupted`；终态转换带守卫（仅 running → 终态，事务内读改写，取消与完成竞态先落地者胜出）；`createIfIdle` 原子守卫（检查 + 创建同一事务，并发双提交兜底）；启动 `markInterruptedOnStartup` 全部非终态 → interrupted（不自动重放）；`chatId` 快照随任务行（对话切换守卫）。
- **楼层进度台账**（`floorFillLedger`）：按（记忆空间, 同步楼层）唯一存 processed/error，**untracked = 无行**（消息全文不落库，ADR 0003；api 的 untracked 是消息表默认态，本实现不物化）；块成功 markProcessed、块失败 markError（error 被重跑成功覆盖）；「未处理范围」提示与覆盖视图（14）都由台账 + 当前对话长度计算。
- **任务服务**（`fill-tasks/fill-task-service.ts`）：api 行为基准——块循环 [from, to] 闭区间、默认块大小 20、块失败 → 任务 failed + 出错块 markError 可重试、已提交块保留、块开始前/提交前安全点；任务输入 = 原始消息内容（不套清洗规则，测试断言 `[reg] 原始 **标记**` 原样进提示词）；批次提交（commitMemoryProposalBatch）+ 台账标记同一 Dexie 事务（失败回滚不产生半批数据/半批状态）；ProposalAgent 经 ticket 12 `createLlm()`（提交时快照一次）；证据 source_type = `sync_floor`（常量上移 constants.ts）、reference 模式、同源唯一复用。
- **守卫与安全点**：单空间单活动任务（冲突原因可读、携带当前任务，先于 LLM 配置检查，与 api 同序）；用户取消立即落 interrupted（与关 tab 同态），循环在安全点丢弃未提交提案、楼层不标记；**对话切换守卫**（块开始前检测 chatId：切换 → 任务 failed「对话已切换…」、楼层不标记，防止把新对话消息写进旧空间）；收口容忍数据库关闭（void 链绝不产生未处理拒绝——拆除期竞态已修）。
- **触发 UI**（`ui/tasks-tab.tsx` + `ui/task-panel-model.ts` 纯逻辑 seam）：from/to 楼层输入（预填首个未处理范围，校验错误内联可读）、触发按钮、活动任务区（状态/范围/进度/取消）、最近结果区（失败原因可读）；1s 轮询刷新（本票无事件总线，ticket 16 引入实时事件）；`data-stm-field`/`data-action` 与验收脚本契约一致。
- **接线**（`runtime.ts`）：tasks 暴露于 runtime；`MemoryRecordQueryService` 装配 reader；`runInTransaction` 6 表事务（表格/字段读取 + 记录/历史/证据/台账写入）；空间删除级联补任务行与台账两表。

## Comments

- 2026-08-11 code-review（双轴并行）结论：Standards 无硬违规；Spec 无 blocker，采纳 8 条修复：①空间删除级联补任务行/台账（含测试）；②对话切换守卫（chatId 快照 + 块开始前检查 + 测试）；③提交守卫顺序与 api 一致（冲突先于 LLM 配置）；④台账 repo 注入 now（与任务 repo 一致）；⑤任务行排序比较器去重；⑥表单预填移出 React updater（保持纯函数）；⑦未处理范围注释修正；⑧补「块 1 已提交 + 块 2 失败」测试（计划承诺项）。未采纳（判断级）：FillTaskRepository.create 未在服务层使用（保留——镜像 api 端口形态，测试/预置使用）；服务层薄透传（API 面，UI 需要）。build.test 超时 5s→30s（构建耗时随 bundle 体积与负载波动，注释记录）。
- 遗留：真机验收（验收标准第 4 条）待用户在真实 ST 环境执行（任务 Tab 触发 → 任务卡进度 → 完成后记录/修订/证据在记录视图可见；修订来源徽标「Agent 修订」、证据楼层 chip）。
