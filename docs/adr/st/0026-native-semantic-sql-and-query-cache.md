---
status: accepted
date: 2026-10-26
---

# 原生语义表值函数与共享查询能力

提供 `semantic_scores(table_key, groups_json, query_text)`，通过 SQLite 原生同名虚拟表支持 SQL 内联调用；缺少评分源时中断当前执行，由外层异步准备后重执行同一 SQL，只有成功的一轮发布结果。真实 WASM 探针表明参数来源标记无法可靠禁止全部行关联，因此保留 SQLite 参数求值语义，采用不同源数、文本数、轮数及累计时间上限约束成本。

查询向量采用执行内请求共享和有界短期成功缓存，评分绑定固定记录与向量输入，SQL 结果不跨执行复用。本轮按用户最新要求只接入记忆宏，查询 Agent 的 `query_semantic_sql` 与 run 级跨工具所有权后续另做，现有 Agent 读写视图保持原状。

旧 sources 格式保留兼容执行与显式转换路径，新 SQL 编辑采用内联函数。该决策扩展 [表达式宏 ADR](./0023-expression-macros-and-generation-evaluation.md)，并调整跨生成必请求查询向量的旧约定；需求、预算与待实施验收见 [需求文档](../../../.scratch/sql-semantic-functions/spec.md)，底层机制的已验证边界见 [技术探针](../../../.scratch/sql-semantic-functions/native-vtab-probe.md)。
