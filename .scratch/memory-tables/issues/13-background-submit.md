# 13 — 正式提交一个消息范围的后台处理任务

**Type:** task

**What to build:** 用户确认预览后，提交一个选定消息范围的后台处理任务；任务执行 Agent、校验并以一个原子 MutationBatch 写入当前表、历史和证据，同时返回来源处理结果。

**Blocked by:** 12 — 校验并预览跨表 MutationBatch

**Status:** ready-for-agent

- [ ] 每次提交生成唯一 `run_id`，范围是一个 1-based inclusive 消息处理块。
- [ ] 正式提交与预览使用相同的 Agent、编译和校验管线。
- [ ] 批次提交成功时统一写入当前记录、旧快照历史、字段证据和 revision 元数据。
- [ ] 批次失败或事务回滚时没有半批数据、半批历史或半批证据。
- [ ] 返回并保存每个 `source_id` 的 processed、skipped、warning、error 结果。
- [ ] 只有正式提交成功后才将来源标记为 processed；来源进度由 Adapter Service 管理。
- [ ] 全局最多一个非终态任务；提交时明确返回冲突任务信息。
- [ ] 任务执行期间目标记忆空间只读，用户仍可查看表格和原始聊天。
