# 09 — 提供统一的 query_records 查询能力

**Type:** task

**What to build:** 提供统一的 `query_records(tableName, field, condition, paging, order)` 等价查询契约，供 Web、Application 和 Agent 只读查询记录，隐藏 SQL 和存储细节。

**Blocked by:** 08 — 实现跨表引用和删除安全

**Status:** ready-for-agent

- [ ] 查询使用稳定的表/字段标识，支持字段投影。
- [ ] 条件按字段类型提供受限比较操作，支持多个条件的 AND 组合。
- [ ] 支持分页和稳定排序；相同排序值有确定的记录 ID 兜底顺序。
- [ ] 能查询当前记录，不允许通过该能力写入、修改或删除。
- [ ] 不暴露 SQL、任意嵌套表达式、任意 JSON 路径或未约定操作符。
- [ ] Web 表格查询和后续 Agent Tool 调用经过同一 Application 契约。
- [ ] 查询错误包含表、字段、条件和分页参数的可定位信息。
