# 14 — 提供任务轮询、暂停、恢复和中止

**Type:** task

**What to build:** 完成后台任务状态机和 Web 轮询控制，支持安全暂停、恢复和中止；控制只在工具轮次之间或提交前生效，不强行打断正在运行的 LLM 请求或 SQLite 事务。

**Blocked by:** 13 — 正式提交一个消息范围的后台处理任务

**Status:** resolved

- [x] 任务至少支持 queued、running、pause_requested、paused、cancel_requested、cancelled、succeeded、failed、interrupted。
- [x] 页面轮询显示当前状态、已处理来源数、总来源数、警告、错误和最近更新时间。
- [x] 暂停请求在安全点生效，暂停期间可查看目标表但不能手动修改目标空间。
- [x] 恢复从同一 run 的未完成安全点继续，不重复提交已成功的原子批次。
- [x] 中止请求在安全点生效；未提交提案被丢弃，正在进行的事务等待真实结果后再确定状态。
- [x] 任务运行时其他记忆空间仍可查看和手动编辑。
- [x] API 重启后所有非终态任务标记为 interrupted，不自动重放。
- [x] 前端能区分请求中与最终状态，避免重复暂停/中止提交。

## Answer

已实现并提交（ticket 14）。

**状态机与安全点**：九态完整（queued → running；running → pause_requested → paused → running；
任意非终态 → cancel_requested → cancelled；running → succeeded/failed；重启 → interrupted）。
控制请求先落库（条件更新，非法转换返回 false 由服务层映射 409），任务循环在两个安全点应用：
块开始前（暂停 → paused 并轮询等待恢复/中止；中止 → cancelled）、块内提交前（中止 → 丢弃
未提交提案，块消息保持 untracked）。不打断正在运行的 LLM 请求或 SQLite 事务。

**迁移 0006**：重建 memory_fill_tasks 表扩展状态约束（SQLite 不能改 CHECK），活动任务唯一索引
排除集扩展为四个终态；暂停/请求中的任务仍算活动（只读保持、冲突提交 409）。

**轮询视图**：FillTaskView = 任务行 + processedCount（实时统计 source_store_messages）+ totalCount
（范围大小）；submit/active/pause/resume/cancel 全部返回视图。

**控制端点**：POST /memory-spaces/:spaceId/fill-tasks/:runId/{pause,resume,cancel}；任务不存在或
不属于该空间 404，非法状态转换 409 携带当前任务。

**重启中断**：FillTaskService.markInterruptedOnStartup() 在 main.ts 与测试应用启动序列中调用，
所有非终态任务标记 interrupted，不自动重放（占用的活动名额释放，可提交新任务）。

**web**：FillTaskPanel 轮询显示状态/进度（processed/total）/最近更新时间，按状态渲染控制按钮
（暂停/恢复/中止），请求中（pendingAction）禁用全部控制避免重复提交；控制可用性抽为纯函数
fill-task-panel-state.ts 并单测。

**测试**：新增 fill-task-lifecycle.test.ts 4 例（暂停/恢复不重跑已成功批次 + 暂停期间只读 +
其他空间可编辑；中止丢弃未提交提案 + 消息保持 untracked + 取消后可重新提交；非法状态转换
409/404；同库重启第二代标记 interrupted）；迁移升级测试 1 例（0004 → 0006 旧行保留、新状态
可写、暂停中任务仍占用活动名额）。全仓 209 测试通过，typecheck/lint 干净（format 告警均为
未触碰的既有文件）。

**边界说明**：「警告」按 ticket 13 的决定不引入（无 skipped/warning 概念）；失败任务的错误信息
随终态展示归 ticket 15（failed 后 active 端点返回 null）。逐消息状态界面与终态任务展示均归 15。
