# 01 — core 记忆查询：查询契约补 in/not_in 多值算子

**What to build:** 记忆查询（ADR 0025 决策 3）落地的 core 侧部分：既有查询契约（`memory-record-query-contract.ts`）补 `in`/`not_in` 算子——`QueryRecordOperator` 扩展；`condition.value` 允许数组（`MemoryFieldValue` 已含 `readonly string[]`）；`MemoryRecordQueryService` 的算子×字段类型校验矩阵与匹配语义（成员匹配）扩展；`query_records` 工具（查询 Agent 面）参数 schema（value 允许数组）与工具描述同步更新。视图侧翻译与渲染见 ticket 02。

**Blocked by:** 无（core 独立可先行；st-extension 侧消费见 ticket 02）

**Status:** ready-for-agent

## Decisions

- 位置：`core/src/memory/application/memory-record-query-contract.ts`（算子/集合定义）+ `memory-record-query-service.ts`（校验与匹配）+ `agent/tools/query/query-records-tool.ts`（schema 与描述）。
- 算子语义：`in` = 字段值 ∈ 值数组；`not_in` = 取反。适用于单值字段（short_text / single_select / number）与系统字段 `$record_id`；value 必须为非空数组；数组元素类型与字段类型匹配（`validateMemoryFieldValue` 复用）。列表字段（多选/多引用）**不适用** in/not_in（成员匹配已有 `contains`/`not_contains`，避免语义重叠）。
- 算子×类型矩阵：`equalityOperators` 旁新增 `inOperators` 集合，服务层校验拒绝矩阵外组合（沿用 `memory_record_query_invalid` 错误路径，reason 可复用/新增）。
- 匹配语义：`#matches` 增加 in/not_in 分支（数组成员匹配）；排序 + 分页 + 投影行为不变。
- `query_records` 工具：`value` schema 扩为 `Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null(), Type.Array(Type.Union([...]))])`；描述补 in/not_in 说明（多值查询不必拆多次 equals；`$record_id` 支持 in/not_in；列表字段仍用 contains/not_contains）。
- 契约测试：in/not_in 成员匹配、空数组拒绝、元素类型不匹配拒绝、列表字段组合拒绝、`$record_id` in、与排序/分页/投影组合语义不变、工具 schema 解析。

事实调研：`docs/research/st-macros-args-and-worldinfo.md`；设计决策：ADR 0025。
