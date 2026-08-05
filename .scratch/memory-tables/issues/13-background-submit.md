# 13 — 正式提交一个消息范围的后台处理任务

**Type:** task

**What to build:** Web 上选择 [n, m] 闭区间消息范围（JSONL 导入的 source_id）并提交后台任务；任务按 blockSize 分批运行填表 Agent（复用 12 的 Agent/编译/校验管线），每批以一个原子 MutationBatch 写入当前记录、旧快照历史、字段证据和 revision 元数据，成功后把本批来源标记为 processed，并保存每个来源的处理结果。

**Blocked by:** 12 — 校验并预览跨表 MutationBatch

**Status:** resolved

- [x] 每次提交生成唯一 `run_id`；任务参数 = `{ memorySpaceId, range: [n, m] 闭区间, blockSize }`，范围拆为连续消息块，每块一次 Agent 调用。
- [x] 每批 Agent 运行与交互式预览共用同一 Agent、编译和校验管线，提交前自动重跑完整校验复核；空提案（Agent 认为无需变更）按成功处理。
- [x] 每批成功时以一个原子事务统一写入当前记录、旧快照历史、字段证据和 revision 元数据（expectedRevisionId 乐观锁，不匹配整批失败）。
- [x] 批次失败或事务回滚时没有半批数据、半批历史或半批证据。
- [x] 保存每个 `source_id` 的状态：`untracked`（默认，未处理）/ `processed`（已填表成功）/ `error`（最后一次运行出错批的消息）；不做 skipped/warning。
- [x] 只有本批原子提交成功后才将本批来源标记为 processed；分批循环与来源进度由 Adapter Service 管理，失败即标记出错批消息为 error 并停止任务。
- [x] 每个记忆空间最多一个非终态任务；冲突提交时明确返回当前任务的 run_id/状态。
- [x] 任务执行期间目标记忆空间只读（application 层拒绝手动写），用户仍可查看表格和原始聊天。

## Comments

### 2026-08 Spec 确认（与用户逐条核对，锁定需求预期）

- **任务内容**：Web 上选择 [n, m] 消息区间（创建 Memory Space 时 JSONL 导入的），按参数分批调用填表 Agent 实现表填写；Agent 耗时长，故上后台任务。任务运行器只负责排队/单任务限制/状态外壳（状态机归 14），**分批循环与来源进度由 Adapter Service 驱动**：每批注入本块消息为证据 + 块范围为 messageRange → 跑 12 的 ProposalAgent → submit 冻结 batch → 完整校验复核 → 单个原子事务提交 → 标记本批 processed → 下一批；失败则标记出错批消息为 error 并停止任务。
- **范围**：[n, m] 闭区间（统一 12 的表述，废弃原"1-based inclusive"措辞）。
- **来源状态**：`untracked`（默认，未处理过）/ `processed`（进行过填表且成功的消息）/ `error`（最后一次运行出错批的消息）；skipped、warning 不做。
- **单任务**：每个记忆空间最多一个非终态任务（非全局）；冲突提交返回当前任务 run_id/状态。
- **进度标记**：Adapter 每批成功标记 processed，失败标记 error 并停止。
- **原子性**：每批一个 SQLite 事务统一写当前记录、历史、证据、revision；expectedRevisionId 乐观锁不匹配则整批失败，无半批数据/历史/证据。
- **只读**：任务期间目标空间 application 层拒绝手动写，查看表格和原始聊天不受影响。
- **微点确认**：a) error 只标记出错批的消息，已成功批次保持 processed、未跑到的消息保持 untracked（14 从出错批恢复重试，不重复提交已成功批次）；b) 空提案按成功处理，本批标记 processed；c) blockSize 为任务参数，默认 20。

## Answer

已实现并提交（commit 见 git log）。

**core**（`@ste-memory/core/memory`，零 pi）：`MemoryRecordMutationOperation` 增加 `create`（tempId + patch + 可选 source/fieldEvidence）；`MemoryRecordMutation` 改为判别联合（create / replace）；`commitMemoryRecordMutationBatch` 支持 create/update/delete 混批原子提交——批内临时 ID 解析为真实 ID、引用字段的 tmp: 值提交时改写、create 不写历史、最终引用校验含批内新建记录；新增 `commitMemoryProposalBatch`（冻结提案 → 记录变更翻译 → 单事务提交，含证据与 revision 乐观锁）。另修复：四个提案状态工具声明 `executionMode: "sequential"`（pi 默认并行执行工具调用，会与 ProposalState 顺序语义竞态）。

**api**：迁移 0004（`source_store_messages.status` untracked/processed/error + `memory_fill_tasks` 表）；`SourceChatRepository` 增加 `messagesInRange`/`markProcessed`/`markError`；`FillTaskService`（Adapter Service）驱动分批循环——每块注入块消息为证据（reference 模式）+ 块范围 → 跑 12 的 ProposalAgent → 空提案按成功 → 冻结 batch 与 processed 标记同一事务原子提交 → 失败标记出错块 error 并停止；每个记忆空间最多一个非终态任务，冲突携带当前任务信息；LLM 配置复用 chat 的 web??env 合并（提交即 400）。`FillTaskWriteGuard` 在 application 层包装 space/table/field/record 四个 manager，任务期间写操作统一 409（`fill_task_space_read_only`）。HTTP：`POST /memory-spaces/:id/fill-tasks`（202/409/404/400）+ `GET .../fill-tasks/active`。

**web**：左侧栏新增填表任务面板（[from, to] 闭区间 + blockSize，默认 20；提交复用 LLM 配置本地保存值；活动任务横幅 + 轻量轮询；只读由服务端强制）。

**测试**：core 新增批量 create 与提案提交矩阵（临时 ID 改写、整批回滚无半批、空批、批内引用解析），并覆盖多工具调用同轮顺序执行；api 集成 6 用例（端到端分块提交、空提案、块失败 error 标记、运行中冲突 409、任务期间只读 409、参数/配置/空间校验）。全仓 172 测试通过，typecheck/lint/prettier 干净（4 个 format 告警为未触碰的既有文件）。

**边界说明**：任务状态机（queued/paused/cancelled/interrupted）、轮询/暂停/恢复与 API 重启后非终态任务标记归 ticket 14；web 面板只显示活动任务（终态展示与逐消息状态界面归 15）。
