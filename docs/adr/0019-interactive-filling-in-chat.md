# 边栏交互式填写：自动落库 + prompt 级提交确认

右侧边栏 Agent tab 新增「填写」模式：复用表格填写 Agent 的提案工具集（query_records + mutate + proposal_preview + drop_mutate + submit_proposal），由聊天宿主在 run 结束后自动提交冻结提案（revisionSource 记 "agent"）；「提交前征得用户明确同意」通过交互式 system prompt 指令约束，而非 UI 硬闸门。

选择 prompt 软闸门的原因：聊天本身已是预览与确认的界面——proposal_preview 展示差异、mutate 即时校验、用户在场逐轮确认，ADR 0009「预览与提交同一管线」继续成立；自动落库避免引入 run 暂停/恢复机制与待决状态（ADR 0009 明确不做持久化待审提案）。本地单用户实验接受软闸门的失效风险（模型可能不遵守指令直接提交），UI 硬闸门留作后续加固方向。

工具定义与 Agent 解耦：5 个工具工厂移入 agent 子层 `tools/` 子包（query/ 与 proposal/ 按域分目录），Agent 类只做薄装配；后台填表任务与边栏交互式填写共享同一管线与工具，行为不变。

不选方案：UI 硬闸门（run 暂停/恢复 + pending 待决状态，复杂度高）；持久化待审提案（ADR 0009 明确不做）；为交互式填写另写一套变更管线（违反 ADR 0008/0009 的单一提交路径）。
