# 13 实现计划：填表任务——手动楼层触发与运行

## 设计决策

- **状态机**（st-extension 简化版，无 queued/pause/cancel_requested）：`running / succeeded / failed / interrupted`，`idle` = 无任务行（api 是 queued→running，本票明确无 queued）。终态 = succeeded/failed/interrupted。
- **中断语义**：启动（页面/浏览器打开）时 `markInterruptedOnStartup()` 把所有非终态任务置 interrupted；用户取消 = 立即把任务行置 interrupted（UI 即时反馈），运行循环在安全点（块开始前、块提交前）检查任务行，丢弃未提交提案、不标记楼层——「块边界检查后停止，与关 tab 同态」。
- **楼层进度台账**：`floorFillLedger` 表按（memorySpaceId, floor）唯一键存 `processed / error` 行；**untracked = 无行**（消息全文不落库，楼层范围随时从 ST 对话实时读取；api 的 untracked 是消息表的默认状态，本实现不物化）。块成功 markProcessed、块失败 markError（error 被后续成功覆盖为 processed）。任务触发 UI 的「未处理范围」与覆盖视图（14）都由台账 + 当前对话长度计算。
- **楼层 = ST 消息数组下标（0 基，ADR 0003）**，范围校验 [0, chatLength-1] 闭区间；与 api 的 1 基 source_id 不同（扩展无消息落库，直接以楼层为来源身份）。
- **块处理 = api `fill-task-service.ts` 行为基准**：块循环 [from, to] 闭区间、默认块大小 20、块失败 → 任务 failed 且出错块 markError 可重试、已提交块保留、块开始前/提交前安全点；**任务输入 = 原始消息内容**（不套清洗规则——ST Regex 用户自行负责）。
- **原子性**：批次提交（commitMemoryProposalBatch）+ markProcessed 同一 Dexie 事务（外事务含 memoryRecords/history/evidence/floorFillLedger，内部 repo 事务按 zone 合并）。
- **证据**：source_type = `"sync_floor"`（与 ui/evidence-chip-model 同源，移到 constants.ts 共享）、source_id = 楼层号、reference 模式；复用既有行（同源唯一）。
- **写入路径**：ProposalAgent（core）经 ticket 12 的 `createLlm()` 端口；query_records 工具需 MemorySpaceReader —— runtime 新增 MemoryRecordQueryService 装配。
- **触发 UI**（任务 Tab，替换占位符）：楼层 from/to 输入 + 未处理范围提示（默认预填首个未处理连续区间）+ 触发按钮 + 运行中任务（状态/范围/进度/取消）+ 最近一次任务结果（失败原因可读）。完整任务列表/覆盖矩阵归 ticket 14。
- **取消竞态**：终态标记（markSucceeded/markFailed）在 repository 层做「仅 running → 终态」守卫（modify + status 过滤），取消先落地则循环不再改写；失败收口前检查任务状态，已中断则不再 markError/markFailed（用户取消的楼层保持 untracked，天然可重试）。

## 新增文件

| 文件 | 内容 |
|---|---|
| `src/fill-tasks/fill-task.ts` | 类型 + 端口：FillTaskStatus/FillTask/FillTaskView、FloorFillStatus/FloorLedgerEntry、FillTaskRepository、FloorLedgerRepository、FillTaskSource（chatMessageCount/messagesInRange）、错误类 |
| `src/db/fill-task-repository.ts` | DexieFillTaskRepository + DexieFloorLedgerRepository（v3 表） |
| `src/fill-tasks/fill-task-block.ts` | buildBlockEvidence + composeBlockPrompt（api 行为基准的浏览器侧副本，无清洗规则） |
| `src/fill-tasks/fill-task-service.ts` | FillTaskService：submit/cancel/activeTask/recentTasks/markInterruptedOnStartup/ledger 查询/块循环 |
| `src/fill-tasks/stream-fn-support.ts` | 测试辅助：scriptedStreamFn/fakeModel/ScriptedEventStream（api chat-stream-support 同模式，非 .test 文件） |
| `src/ui/task-panel-model.ts` | 纯逻辑视图模型：状态文案/进度/未处理范围/楼层输入校验 |
| `src/ui/tasks-tab.tsx` | 任务 Tab React 组件（触发表单 + 活动任务 + 最近结果；1s 轮询） |

## 修改文件

| 文件 | 改动 |
|---|---|
| `src/db/database.ts` | v3 schema：memoryFillTasks（runId 主键、[memorySpaceId+createdAt]）、floorFillLedger（&[memorySpaceId+floor]、memorySpaceId） |
| `src/db/index.ts` | 导出新 repository |
| `src/constants.ts` | EVIDENCE_FLOOR_SOURCE_TYPE = "sync_floor"（从 ui/evidence-chip-model 上移，原处 re-export 兼容） |
| `src/st/st-chat-adapter.ts` | 补 chatMessageCount()/messagesInRange(from, to)（薄映射，getMessageAt 同法） |
| `src/runtime.ts` | 装配 FillTaskService + MemoryRecordQueryService + reader；暴露 runtime.tasks；启动 markInterruptedOnStartup |
| `src/ui/panel-shell.tsx` | PanelRuntime 补 tasks/st 字段；任务 Tab 换 TasksTab |
| `src/ui/index.ts` | 导出新模块 |
| `src/style.css` | 任务 Tab 样式（走 --stm-* 令牌） |

## TDD 顺序（红-绿-重构，每步跑单个测试文件）

1. `db/fill-task-repository.test.ts` — 台账 upsert/覆盖/空间隔离/范围查询/计数；任务行 create/findActive/守卫终态/启动中断/listRecent
2. `fill-tasks/fill-task-block.test.ts` — 证据复用与新建、提示词原文
3. `fill-tasks/fill-task-service.test.ts` — e2e 成功（2 块：记录+证据+台账+任务 succeeded）、空提案、块失败（error 楼层 + failed + 可读原因 + 已提交块保留）、冲突守卫（可读）、取消（interrupted + 提案丢弃 + 楼层不标记）、启动中断不重放、范围校验、重跑证据复用、原文不套清洗
4. `ui/task-panel-model.test.ts` — 视图模型与输入校验
5. `runtime.test.ts` 补接线断言；`panel-shell.test.tsx` 补任务 Tab 冒烟
6. 全仓测试 + typecheck + lint + build

## 验收对应

- [x] 手动选楼层范围触发；状态 running → succeeded/failed 正确推进（服务测试）
- [x] 中断语义（启动标记 interrupted 不重放；取消同态）（服务测试）
- [x] 单空间单活动任务守卫；失败原因可读（服务测试 + UI 文案）
- [ ] 手动验收：真实 ST + 真实 LLM（需要用户环境，文档说明跑法）
