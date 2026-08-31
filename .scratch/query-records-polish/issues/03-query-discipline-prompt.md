# 03 — query_records 查询纪律提示词（待办）

**What to build:** `query_records` 工具描述 + 三套系统提示词补「查询纪律」，抑制填表 Agent 首轮并发全表查询的 token 浪费。

**Status:** resolved（2026-08-31 已实施）

## Decisions

- 落点一：`query-records-tool.ts` 的 `QUERY_RECORDS_TOOL_DESCRIPTION`——优先用 conditions 缩小范围、禁止无条件全表查询；fields 只投影用得到的列；少量记录时 pageSize 取小；先查最相关的 1–2 张表、逐轮增量精化，避免首轮并发查询全部表。
- 落点二：`prompt-composer.ts`——
  - `PROPOSAL_AGENT_BASE_INSTRUCTIONS`（后台填表）：加「只查询与本块消息内容相关的表，块消息未提及的主题不要预查」；
  - `composeQueryAgentSystemPrompt`（问答）与 `composeInteractiveProposalAgentSystemPrompt`（交互填表）：各补「先窄后宽」一句。
- 提醒：用户侧自定义预设不含 `{{systemDefaultPrompt}}` 时 core 默认规则不生效，纪律要写进预设本身。

## Comments

- 2026-08-31：三问题之三。用户确认走纯提示词方案，未列入本轮实施。
- 2026-08-31 实施完成：工具描述首行改为「只读」并新增两行查询纪律（先用 conditions 缩小范围、禁无条件全表、fields 投影、pageSize 取小、先查最相关 1–2 表逐轮精化、不一次并发查全部表）；`PROPOSAL_AGENT_BASE_INSTRUCTIONS` 规则区新增「只查询与本块消息内容相关的表，块消息未提及的主题不要预查」；`composeQueryAgentSystemPrompt` 工作方式新增第 5 条「查询先窄后宽」；`composeInteractiveProposalAgentSystemPrompt` 规则区新增「只查询与当前指令相关的表，不要全表拉取」。core 223 测试与全仓 typecheck 通过。