# 24 — core 统一表达式：结构化筛选/排序/条数求值

**What to build:** 统一表达式（ADR 0025 决策 3）：结构化 JSON 描述 `{ conditions: [{ fieldKey, operator: 'in'|'eq', values: string[] }], sort: { by: 'updatedAt', direction: 'desc' }（v1 固定）, limit? }`，多条件 AND 语义；core 纯函数求值（筛选 → 排序 → 取条数，返回记忆记录子集）。表达式是只读选取语义，不产生修订、不写库。apps（api/web）与 st-extension 共享同一结构与求值，各客户端只负责把用户输入翻译成统一表达式。

**Blocked by:** 无（core 独立可先行；st-extension 侧消费见 ticket 25）

**Status:** ready-for-agent

## Decisions

- 位置：application 层只读侧（`core/src/memory/application/`，与 `memory-record-display` / `memory-record-query-*` 同级），新增纯函数模块（如 `memory-expression.ts`）。
- 求值语义：条件 = 字段 Key 精确匹配记录 fields（v1 只处理 string 值字段：single_select 存选项字符串、short_text 存文本；in = 值集合包含、eq = 精确相等）；多条件 AND；随后按 updatedAt 倒序（createdAt/id 兜底，与快照组装 `newestFirst` 同序）；最后取前 limit 条（limit 缺省 = 不截）。
- 字段/字段值类型不匹配（如条件指向引用字段、long_text）→ 该条件对记录判为不匹配（不抛错）；未知字段 Key → 表达式整体不匹配任何记录（调用方决定是否告警）。
- 结构可 JSON 序列化（纯数据，无函数引用）；求值纯函数输入 = 记录数组 + 表达式 + 字段定义（用于识别字段类型），输出 = 记录子集。
- 契约测试：AND 语义、in/eq 边界、空值集合、未知字段、排序确定性、limit 边界。

事实调研：`docs/research/st-macros-args-and-worldinfo.md`；设计决策：ADR 0025。
