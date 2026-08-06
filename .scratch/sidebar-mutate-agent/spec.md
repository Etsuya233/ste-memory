# 边栏交互式填写 Agent（查询 + 变更）

Status: 已确认

## 目标

右侧边栏 Agent tab 目前只有 QueryAgent（只读查询聊天）。新增「填写」模式：同一聊天宿主装配提案工具集（查询 + 变更），自动落库，提交前由 prompt 约束征得用户明确同意。工具定义与 Agent 解耦为独立 tools 子包。

## 已确认决策（grilling 会话 2026-08）

1. **复用既有提案管线**：新 Agent 装配 ProposalAgent 的 5 工具集，不新写 Agent 引擎；QueryAgent 原样保留。
2. **Mutate 范围仅记忆记录** create/update/delete；表格/字段/显示策略/清洗规则仍走手动 CRUD。
3. **自动落库**：run 结束（`submit_proposal` 冻结提案）后宿主立即 commit；`done` 事件携带提交结果。
4. **确认机制 = prompt 软闸门**：交互式 system prompt 指令「提交前先陈述变更并征得用户明确同意」；无 UI 硬闸门。接受 LLM 可能不遵守的局限（本地单用户实验）。
5. **工具与 Agent 解耦**：工具工厂移入 core agent 子层 `tools/` 子包，按域分目录（`query/`、`proposal/`）；Agent 类保留为薄装配。
6. **端点扩展** `POST /memory-spaces/:id/chat`：body 加 `agent: "query" | "proposal"`，缺省 `"query"` 向后兼容。
7. **UI**：Agent tab 内模式切换「查询 / 填写」；QueryChatPanel 泛化；按（空间 × 模式）各存独立历史；提交后**不自动刷新**，面板提供固定「刷新表格」按钮（bump `recordRefreshVersion`）。
8. **并发写**：聊天 commit 直通 repository，不经 `FillTaskWriteGuard`；守卫保持现状（用户侧放开后续另做）。
9. **零证据注入**（v1，领域校验不强制）；`messageRange` 用合成值（commit 不使用它）。
10. **修订来源**：提交的 `revisionSource = "agent"`（用户确认是闸门不是作者）。
11. **术语**：交互式填写（apps/CONTEXT.md 已记）；API agent id `"query"/"proposal"`；UI 标签「查询/填写」。

## 非目标

- UI 硬闸门（run 暂停/恢复 + pending 待决状态）
- 表格/字段定义经 Agent 修改
- 证据注入与「消息 → 证据条目」映射
- 填表任务写守卫的放宽（用户侧后续另做）
- 持久化待审提案（沿用 ADR 0009）

## 结构

```
core/src/memory/application/agent/
├── query-agent.ts / proposal-agent.ts      # 薄装配（不变更行为）
├── prompt-composer.ts                      # + composeInteractiveProposalAgentSystemPrompt
├── digest.ts / agent-run.ts / llm-port.ts / memory-space-reader.ts
└── tools/
    ├── query/query-records-tool.ts
    └── proposal/{mutate,proposal-preview,drop-mutate,submit-proposal}-tool.ts
                 + proposal-state.ts + proposal-tool-error.ts + proposal-compiler.ts
```

## 验收路径（手动）

填写模式对话：用户要求变更 → Agent 陈述变更并询问 → 用户明确同意 → `submit_proposal` → run 结束宿主自动 commit → `done` 携带 committed 摘要 → 点「刷新表格」看到新数据；RecordInspector 显示「Agent 修订」。
