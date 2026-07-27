# 12 — 校验并预览跨表 MutationBatch

**Type:** task

**What to build:** 将 Agent Tool Calling 或领域 DSL 编译成统一 MutationBatch，执行完整校验并生成差异预览；预览不持久化、不创建历史、不更新任务进度。

**Blocked by:** 11 — 为选定消息范围生成 Agent 提案

**Status:** ready-for-agent

- [ ] Tool 和 DSL 经过同一编译器生成统一的 create/update/delete MutationBatch。
- [ ] 校验表/字段/类型/必填/选项/引用目标、稳定 ID、expected revision 和删除安全。
- [ ] 支持批次内临时 ID，并在提交前解析为真实 ID。
- [ ] 明确禁止 upsert；找不到目标记录的更新必须失败或由提案改为创建。
- [ ] 跨表操作和历史快照边界以一个原子批次表达。
- [ ] 预览显示新增、字段变更、删除、证据和失败原因，可按表筛选。
- [ ] 预览失败不写入当前表、历史表、证据或来源处理进度。
