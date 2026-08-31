# 02 — query_records 空结果返回 tips 诊断字段

**What to build:** `query_records` 工具结果在**无匹配记录**（`records` 为空数组）时附带 `tips` 诊断文本，引导模型修正查询而不是转去全表拉数据；非空结果不附带。

**Blocked by:** 无（工具呈现层独立改动，服务层与宿主不动）

**Status:** ready-for-agent

## Decisions

- 位置：`core/src/memory/application/agent/tools/query/query-records-tool.ts`——`QueryRecordsToolResult` 增加可选 `readonly tips?: string`；`executeQueryRecords` 在 `page.records.length === 0` 时组装，否则不出现该字段。`MemoryRecordQueryService`、api、st-extension 均只透传 details，无代码改动。
- tips 内容（按查询实情组装，两条足够）：
  1. 通用：「未找到满足条件的记录。可放宽条件或分页后重试；若确无匹配请如实回答。」
  2. 引用字段条件检测：遍历本次查询条件（含未来 `filter` 树），若某条件字段在 digest 中 `referenceTableKey != null`（即引用字段），追加：「条件包含引用字段（xxx，值为目标记录 id）：若你传入的是目标记录的**显示文本**，请先在目标表查询该文本对应记录的 id，再用 id 作为条件值。」引用字段 key 列表去重后存在才追加。
- 目的：引用字段值校验是宽松的（任何非空字符串都通过），拿显示文本当值**静默返回空**——tips 让静默失败变成可自愈失败。
- 描述同步：`QUERY_RECORDS_TOOL_DESCRIPTION` 补一句「无匹配记录（records 为空）时响应附带 tips 诊断，请据其修正查询」。
- 测试：`core/test/agent/query-records-tool.test.ts` 加用例——空结果含通用 tips；条件含引用字段时空结果 tips 含两步法提示；非空结果无 tips 字段。

## Comments

- 2026-08-31：三问题之二的落地轮次。用户确认：`values` 保持裸 id 不动，只做空结果 tips。