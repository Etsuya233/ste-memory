# 02 — api：/chat 支持 agent 选择与自动提交

**Type:** task

**Blocked by:** 01

**What to build:** 扩展聊天端点支持「填写」模式（spec 决策 3/6/8/9/10）。

- `ChatBody` 加 `agent?: "query" | "proposal"`，缺省 `"query"`（向后兼容，QueryAgent 路径行为不变）。
- `chat-manager` 按 agent 装配：`proposal` 时构造 ProposalAgent（注入 `MemoryProposalPorts`，复用填表任务的 outbound 装配）与交互式 prompt；`messageRange` 用合成值（如 `{from: 0, to: 0}`），证据传空数组。
- run 结束后若存在冻结提案，宿主立即 `commitMemoryProposalBatch(..., "agent")`。
- `done` 事件扩展携带提交结果：`commit: { status: "committed" | "failed", created, updated, deleted, error? }`；未提交（无提案）时 `commit` 缺省。
- 并发写：提交路径直通 repository，不挂 `FillTaskWriteGuard`。
- 预检错误语义与现有聊天一致（配置缺失 400 / 空间不存在 404 走 SSE 头前 JSON；流中错误走 SSE error 事件）。

**Status:** ready-for-agent

**验收:** api 测试（或手动 curl）验证：`agent: "proposal"` 对话 → 用户确认 → `done` 携带 committed 摘要；`agent` 缺省时行为与现状完全一致；无提案对话 `done` 无 commit 信息。
