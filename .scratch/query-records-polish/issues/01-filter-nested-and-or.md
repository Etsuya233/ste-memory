# 01 — query_records 支持 (a AND b) OR (c AND d) 嵌套条件（暂停）

**What to build:** `query_records` 工具支持逻辑组合条件：单次查询表达 `(a AND b) OR (c AND d)` 这类嵌套布尔结构，替代「模型并发发多条查询再自行合并」的错误习惯（填表 Agent 常把多条件当成 OR 误用）。

**Status:** needs-triage（暂停；先上 ticket 02 空结果 tips + ticket 03 提示词纪律，观察模型对引用字段/空结果的自愈行为是否改善，再决定是否引入本结构）

**关联:** 02（引用字段空结果提示）、03（查询纪律提示词）

## Decisions

- 形状：递归布尔节点，**固定两级**，不用任意深度树。`filter` 顶层 = 单条件（便捷形态）或 `{ and: [...] }`/`{ or: [...] }` 节点；节点元素 = 条件 或 条件组（`{ and: 条件[] }`/`{ or: 条件[] }`，组内不再嵌套）。
- TypeBox Schema（静态展开，不用 `Type.Recursive`/`Cyclic`——1.3 的 `Cyclic` 对 `Static` 推断不友好）：
  ```ts
  const queryRecordFilterGroupSchema = Type.Union([
    Type.Object({ and: Type.Array(queryRecordConditionSchema) }),
    Type.Object({ or: Type.Array(queryRecordConditionSchema) }),
  ]);
  const queryRecordFilterSchema = Type.Union([
    queryRecordConditionSchema,
    Type.Object({ and: Type.Array(Type.Union([queryRecordConditionSchema, queryRecordFilterGroupSchema])) }),
    Type.Object({ or: Type.Array(Type.Union([queryRecordConditionSchema, queryRecordFilterGroupSchema])) }),
  ]);
  ```
- 契约类型（core 判别联合）：`QueryRecordFilter = 条件 | {and: 元素[]} | {or: 元素[]}`；`元素 = 条件 | {and: 条件[]} | {or: 条件[]}`。
- 兼容：现有扁平 `conditions` 保留（等价 `filter: { and: conditions }`）；两者同时提供 → 拒绝（明确报错，不静默合并）。
- 匹配语义：`(a∧b)∨(c∧d)` = `{ "or": [ { "and": [a, b] }, { "and": [c, d] } ] }`；服务层递归求值，分页/排序/投影/错误路径沿用。
- 错误定位：`#invalid` param 增加 filter 路径（如 `filter.or[0].and[1]`），工具层回喂模型辅助自愈。
- 描述：工具描述给与用户场景同构的完整示例；提示词补「一次查询内 and/or 语义」说明。

## Comments

- 2026-08-31：讨论中沉淀的三问题之一（多条件 OR 误用）。原推荐 `match + groups` 双层参数被用户判为不直觉，换为递归 and/or 树。先暂停，等 tips + 提示词方案跑一段时间评估效果。