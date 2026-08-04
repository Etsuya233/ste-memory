# 12 — 校验并预览跨表 MutationBatch

**Type:** task

**What to build:** 实现提案生成 Agent（复用 11 的引擎与 query_records，挂载 submit_proposal 工具），将其 Tool Calling 或领域 DSL 编译成统一 MutationBatch，执行完整校验并生成差异预览；预览不持久化、不创建历史、不更新任务进度。

**Blocked by:** 11 — 实现 Agent 引擎与 QueryAgent

**Status:** ready-for-agent

- [ ] Tool 和 DSL 经过同一编译器生成统一的 create/update/delete MutationBatch。
- [ ] 校验表/字段/类型/必填/选项/引用目标、稳定 ID、expected revision 和删除安全。
- [ ] 支持批次内临时 ID，并在提交前解析为真实 ID。
- [ ] 明确禁止 upsert；找不到目标记录的更新必须失败或由提案改为创建。
- [ ] 跨表操作和历史快照边界以一个原子批次表达。
- [ ] 预览显示新增、字段变更、删除、证据和失败原因，可按表筛选。
- [ ] 预览失败不写入当前表、历史表、证据或来源处理进度。

## Comments

### 自 11 移入（2026-08 重新拆分）

提案生成相关从 11 移入本 Ticket：

- submit_proposal 工具：参数即提案 DSL；执行时轻量结构校验（不查库：op 合法、必需字段齐、fieldEvidence 的 source_id 落在当前处理块内），失败 throw（pi 转 isError 回喂自愈）；完整领域校验（表/字段存在性、类型、必填、选项、引用、revision）由本 Ticket 的编译器与校验器承担。
- 提案 DSL 形状：
  ```jsonc
  create: { type, table, tempId, patch, fieldEvidence? }
  update: { type, table, recordId, expectedRevisionId, patch, fieldEvidence? }
  delete: { type, table, recordId, expectedRevisionId }
  fieldEvidence: { [fieldKey]: [{ source_type, source_id }] }  // 仅引用处理块内消息
  ```
- 映射：query_records 结果 `id` → 操作 `recordId`；结果 `revisionId` → `expectedRevisionId`（提交时 `WHERE revision_id = expected` 做乐观锁，不匹配整批失败）；create 无 revision。
- 提案提取：agent_end 后取最后一次成功 submit_proposal 的参数；`CustomAgentMessages` 声明合并延后。
- 提案提示词 = 基础指令 + 启用表/字段摘要 + 所选消息范围（1-based 闭区间，后端映射稳定 source_id）。
- 原 11.5 的 Web 提案界面内容（范围选择、提案面板、确认提交）随提案流归入本 Ticket 及其后续 web 拆分。
