# 12 — 校验并预览跨表 MutationBatch

**Type:** task

**What to build:** 实现提案生成 Agent（复用 11 的引擎与 query_records），挂载 mutate / proposal_preview / drop_mutate / submit_proposal 工具：模型增量构建提案到会话内 State，引擎编译为统一 MutationBatch，执行完整校验并生成差异预览；预览不持久化、不创建历史、不更新任务进度。DSL 暂不做（数据结构保留，后续可复用）；证据与消息范围由外部注入，模型不感知。

**Blocked by:** 11 — 实现 Agent 引擎与 QueryAgent

**Status:** ready-for-agent

- [ ] 所有 mutate 调用经同一编译器生成统一的 create/update/delete MutationBatch（DSL 暂不做，后续引入时走同一编译器）。
- [ ] 工具集：mutate（累加/覆盖单操作）、proposal_preview（完整校验+差异预览）、drop_mutate（去掉操作）、submit_proposal（唯一完成信号+最终复核）。
- [ ] 校验分层：mutate 即时校验（schema/表/字段/类型/必填/选项/目标存在性）；proposal_preview 跨操作校验（expected revision、引用目标、tempId 解析、删除安全、原子边界）。
- [ ] 批次内临时 ID 由引擎分配（tmp: 前缀），提交前解析为真实 ID；create 支持可选 tempId 覆盖。
- [ ] 同表同标识重复操作直接覆盖（跨 op 也覆盖），mutationId 保持不变，返回 replaced 提示。
- [ ] 明确禁止 upsert；找不到目标记录的更新必须失败或由提案改为创建。
- [ ] 跨表操作和历史快照边界以一个原子批次表达（submit 冻结的 batch 供 13 提交）。
- [ ] 预览显示新增、字段变更、删除和失败原因，可按表筛选；messageRange 与 evidence 不返回给模型。
- [ ] 预览失败不写入当前表、历史表、证据或来源处理进度。
- [ ] submit_proposal 自动重跑完整校验复核，失败 throw 回喂；模型自然停止 = 无提案，State 丢弃。
- [ ] 证据（当前处理块消息整批）与消息范围 n->m 由外部注入，工具不涉及；query_records 不反映 pending 变更（提示词说明）。

## Comments

### 2026-08 设计确认（工具化增量提案；DSL 暂不做）

原"submit_proposal 参数即提案 DSL"方案改为增量工具 + 会话内 State。工具字段一律用 key（digest 映射 id），错误一律 throw（pi 转 isError 回喂），与 11 一致。

#### 工具定义

**`mutate` — 累加/覆盖单个操作到 State**

参数（discriminated union，op 区分三个分支）：

```jsonc
// create
{ "op": "create", "table": "person",
  "patch": { "name": "张三", "status": "active" },   // 必填；value: string|number|boolean|null
  "tempId": "tmp:r1" }                                // 可选：传了覆盖同 tempId 操作；不传引擎分配

// update
{ "op": "update", "table": "person",
  "recordId": "r_123", "expectedRevisionId": "rev_9",
  "patch": { "status": "archived" } }                 // 必填；省略字段保持不变，null 清空

// delete
{ "op": "delete", "table": "person",
  "recordId": "r_456", "expectedRevisionId": "rev_12" }
```

返回：

```jsonc
{
  "mutationId": "M3",                // 引擎分配；覆盖时保持不变（drop 依然有效）
  "tempId": "tmp:r1",                // 仅 create：新分配或覆盖目标的 tempId
  "replaced": true,                  // 本次是否覆盖了同表同标识的旧操作
  "summary": "create person 张三 (tmp:r1)"
}
```

即时校验（不过关 throw）：op/表/字段合法、类型、必填、选项值（digest 生成动态 schema）；update/delete 的目标记录存在性查库一次；不查 revision。引用字段值 = 已有记录 id 或本批次 tmp: 前缀 tempId（可指向后续才创建的 create）。

**`proposal_preview` — 完整校验 + 差异预览**

参数：

```jsonc
{ "table": "person" }   // 可选：只预览该表的操作
```

返回（业务校验失败是**正常返回**，不是 throw；不返回 messageRange/evidence）：

```jsonc
{
  "valid": false,                      // 整批一致性校验结果
  "tables": ["person", "relationship"],
  "operations": [
    { "mutationId": "M1", "op": "create", "table": "person", "tempId": "tmp:r1",
      "display": "张三", "values": { "name": "张三", "status": "active" },
      "changes": [ { "field": "name", "old": null, "new": "张三" }, ... ] },   // create 全为新增
    { "mutationId": "M2", "op": "update", "table": "person", "recordId": "r_123",
      "display": "李四",
      "changes": [ { "field": "status", "old": "active", "new": "archived" } ] },
    { "mutationId": "M3", "op": "delete", "table": "person", "recordId": "r_456",
      "display": "王五" }
  ],
  "errors": [                          // valid=false 时列出全部失败原因（模型据此修正）
    { "mutationId": "M2", "message": "expectedRevisionId rev_9 不匹配当前 rev_11" }
  ]
}
```

校验内容（查库）：expectedRevision 匹配、引用目标存在且类型匹配、tempId 解析、删除安全（被删记录不得仍被批次外记录引用）、原子批次边界。副作用：无——不写当前表/历史表/证据/进度。

**`drop_mutate` — 去掉某个操作**

参数：

```jsonc
{ "mutationId": "M1" }
```

返回：

```jsonc
{
  "dropped": "M1",
  "remaining": 2,                      // State 剩余操作数
  "summary": "dropped update person r_123"
}
```

mutationId 不存在 → throw 回喂。drop 后若有操作引用了被删的 tempId，由下次 proposal_preview 报出。

**`submit_proposal` — 完成信号（唯一）**

参数：无。

返回（引擎先自动重跑 preview 全部校验做最终复核；**失败 throw 回喂**，成功才冻结提案）：

```jsonc
{
  "status": "submitted",
  "proposal": {
    "messageRange": { "from": 10, "to": 25 },
    "evidence": ["source:msg_10", "..."],
    "operations": [ ... ],             // 与 preview 相同的展开结构，含解析后的真实 id
    "batch": {                         // 统一 MutationBatch，供 13 提交
      "create":    [ { "table": "person", "tempId": "tmp:r1", "patch": {...} } ],
      "update":    [ { "table": "person", "recordId": "r_123", "expectedRevisionId": "rev_9", "patch": {...} } ],
      "delete":    [ { "table": "person", "recordId": "r_456", "expectedRevisionId": "rev_12" } ]
    }
  }
}
```

唯一完成信号：模型自然停止（无 submit）＝ 无提案，State 丢弃。

**`query_records`（11 已实现，原样复用）**：参数 `{ table, fields?, filters?: [{ field, op, value }], page?, pageSize?, sort? }`；返回 `{ records: [{ id, revisionId, display, values }], total }`（引用字段裸 id）。

#### 覆盖规则

同表同标识（recordId/tempId）视为同一操作，新 mutate 覆盖旧的（跨 op 也覆盖：delete 后 update = 取消删除改更新），mutationId 保持不变，返回 replaced 提示。create 覆盖通过可选 tempId 参数（模型从之前 create 的返回中记住）。

#### 证据与消息范围（外部注入）

证据 = 当前处理块消息整批关联，提交时由应用层统一附加（snapshot/reference 模式由 Adapter 定）；消息范围为任意闭区间 n->m（不再限定 1-based），由外部传入，Agent 只管看 Prompt 内容对表操作；提案携带覆盖范围，12 不持久化进度，13/14 提交成功后据此标记已处理。模型表达理由用表中"原因"字段。

#### 校验分层

- mutate 时（即时反馈）：TypeBox schema + 表/字段/类型/必填/选项 + update/delete 目标记录存在性（查库一次）。不查 revision。
- proposal_preview / submit 复核时（跨操作，查库）：expectedRevision 匹配、引用目标、tempId 解析、删除安全、原子边界。

#### 模块划分（大体规则，实现细节自行发挥）

- **memory 层（零 pi，领域）**：`MutationOperator`（create/update/delete + tempId/expectedRevisionId）、`MutationBatch`（扩展现有 memory-record-mutations）、完整校验器（单操作 + 跨操作一致性，查库经 repository 端口）、`MutationPreviewer`（差异计算 + 预览结构，支持按表筛选）、校验错误模型。预览与提交（13）共用这套规则。
- **agent 层（编排）**：`ProposalState`（mutationId/tempId 分配、覆盖语义）、工具参数 key→id 编译适配、四个 AgentTool、ProposalAgent（复用 11 的循环，每请求一实例一 State）、提示词扩展。
- 衔接：`MutationOperator` 带可选纯数据字段 `externalId`（agent 传 mutationId），Previewer 原样回显，模型可据此定位错误；memory 层不感知 Agent 概念。

#### 其他

- query_records 不反映 pending 变更（不做 overlay）；提示词说明"未提交变更用 proposal_preview 查看，query_records 只反映已提交数据"。
- 提案提示词 = 基础指令 + 启用表/字段摘要 + 外部注入的处理块消息内容。
- 原 11.5 的 Web 提案界面内容（范围选择、提案面板、确认提交）随提案流归入本 Ticket 及其后续 web 拆分。
- 工具轮次上限本次不做（沿用 11：5 分钟超时兜底）。
- 测试：core 级脚本化假 streamFn，覆盖 mutate 累加/覆盖、校验矩阵、drop、preview 无副作用、submit 复核、tempId 解析、错误回喂。

### DSL 暂不做（结构保留复用）

DSL 输入暂不做，但数据结构保留，后续引入时经同一编译器：Tool 调用与 DSL 最终编译为同一种 MutationBatch。保留的 DSL 形状（与工具参数一一对应）：

```jsonc
create: { type, table, tempId, patch, fieldEvidence? }
update: { type, table, recordId, expectedRevisionId, patch, fieldEvidence? }
delete: { type, table, recordId, expectedRevisionId }
fieldEvidence: { [fieldKey]: [{ source_type, source_id }] }  // 仅引用处理块内消息
```

映射规则（工具/DSL 共用）：query_records 结果 `id` → 操作 `recordId`；结果 `revisionId` → `expectedRevisionId`（提交时 `WHERE revision_id = expected` 做乐观锁，不匹配整批失败）；create 无 revision。fieldEvidence 目前由外部统一注入（整批关联），DSL 恢复时若需逐字段证据再启用该字段。

### 拆分历史

- 提案生成相关内容（submit_proposal、提案 DSL、消息范围处理、提案端点、提案提示词）从 11 移入本票；原 DSL 方案于 2026-08 设计确认时改为工具化增量提案，DSL 暂不做但数据结构保留。
- 原 11.5 的 Web 提案界面内容（范围选择、提案面板、确认提交）随提案流归入本 Ticket 及其后续 web 拆分。
