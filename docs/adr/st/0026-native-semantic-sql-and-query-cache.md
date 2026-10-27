---
status: accepted
date: 2026-10-26
---

# 原生语义表值函数与共享查询能力

提供 `semantic_scores(table_key, groups_json, query_text)`，通过 SQLite 原生同名虚拟表支持 SQL 内联调用；缺少评分源时中断当前执行，由外层异步准备后重执行同一 SQL，只有成功的一轮发布结果。真实 WASM 探针表明参数来源标记无法可靠禁止全部行关联，因此保留 SQLite 参数求值语义，采用不同源数、文本数、轮数及累计时间上限约束成本。

查询向量采用执行内请求共享和有界短期成功缓存，评分绑定固定记录与向量输入，SQL 结果不跨执行复用。本轮按用户最新要求只接入记忆宏，查询 Agent 的 `query_semantic_sql` 与 run 级跨工具所有权后续另做，现有 Agent 读写视图保持原状。

旧 sources 格式保留兼容执行与显式转换路径，新 SQL 编辑采用内联函数。该决策扩展 [表达式宏 ADR](./0023-expression-macros-and-generation-evaluation.md)，并调整跨生成必请求查询向量的旧约定；需求、预算与待实施验收见 [需求文档](../../../.scratch/sql-semantic-functions/spec.md)，底层机制的已验证边界见 [技术探针](../../../.scratch/sql-semantic-functions/native-vtab-probe.md)。

## 2026-10-27：共享执行器接入

语义查询的快照、显示值刷新、评分缓存、SQL 重执行与取消生命周期移入 `features/semantic-query`。
宏继续保留 Query 编译和旧 sources 兼容；查询 Agent 新增 `query_semantic_sql`，每次调用读取新的
committed 快照，接受显式命名参数，最多返回 100 行并探测截断。手动 SQL 控制台使用统一入口，由 SQLite 原生虚拟表规划识别语义依赖；遇到该语句时暂停并交给共享
只读执行器，完成后继续 SQL 尾部，避免重跑已经执行的写入。语义语句最多返回 10000 行；
普通语句的原有权限与多语句顺序保持原样，含语义依赖的写入在 stepping 前拒绝。
控制台填写显式查询文本，不自动读取对话消息；Agent 使用显式参数。宏保留原有消息上下文。
三者由运行时注入同一个 QueryVectorCache，跨执行共享成功向量；各自执行内拥有在途请求及取消，
暂不合并不同工具调用的在途请求。语义执行均沿用累计 SQL 1 秒、总等待 10 秒、16 源、4 文本、17 轮限制。
填表 Agent 的工具、write 视图与未提交记录读取规则保持原状。
