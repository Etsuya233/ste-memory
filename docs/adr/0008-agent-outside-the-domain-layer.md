# 表格填写 Agent 位于领域层之外

采用精简的 Clean Architecture：领域层只拥有表格模型、字段校验、引用约束和修订规则；应用层编排表格填写 Agent、事务与用例；HTTP、SillyTavern、LLM Provider 和持久化均作为适配器。Agent 可多次使用只读查询工具，但所有写入汇总为一个与模型无关的跨表原子批次；Tools 和结构化 DSL 均编译到这一命令，不直接写库。
