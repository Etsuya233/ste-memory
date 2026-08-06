# 03 — web：边栏 Agent 模式切换与刷新按钮

**Type:** task

**Blocked by:** 02

**What to build:** 右侧边栏 Agent tab 支持「查询 / 填写」两种模式（spec 决策 7）。

- `QueryChatPanel` 泛化为通用 Agent 聊天面板（如 `AgentChatPanel`）：顶部模式选择器「查询 / 填写」，切换即切换 `agent` 请求字段与各自的消息历史。
- 消息历史按（空间 × 模式）各存一份（现有内存 Map 维度扩展），切换模式不丢历史。
- `LlmConfigForm` 两模式共用。
- 填写模式：`done` 事件带 committed 摘要时显示结果提示（"已应用 N 条变更" / 失败错误信息）。
- 面板提供固定「刷新表格」按钮：通过回调（MemoryWorkspace → RecordInspector → 面板）bump `recordRefreshVersion`，提交成功后由用户手动点击刷新表格（不做自动刷新）。
- 工具调用卡片复用 `AgentActivityView`（mutate/preview/submit 的参数与结果已有通用渲染）。

**Status:** resolved

**验收:** 手动走通：填写模式对话 → Agent 陈述变更并询问 → 用户同意 → 自动提交 → 提示摘要 → 点「刷新表格」看到新数据；RecordInspector 历史 tab 显示「Agent 修订」；切 tab / 切模式不丢各自历史。

## Answer

已实现（e5cb91a + 6bb5e53）：QueryChatPanel → AgentChatPanel（查询/填写模式切换）；按（空间×模式）独立历史；「刷新表格」按钮（bump recordRefreshVersion，不自动刷新）；committed/failed 结果横幅；streamChat 携带 agent。web 37 测试全绿（含 done commit 3 例）。
