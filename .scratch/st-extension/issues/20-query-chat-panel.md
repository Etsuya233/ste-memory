# 20 — 问答面板（查询/填写双模式）

**What to build:** 面板新 Tab「问答」：与 Agent 聊天。查询模式 = QueryAgent 只读问答（core `composeQueryAgentSystemPrompt` 固定提示词）；填写模式 = 交互式填写（ProposalAgent + `composeInteractiveProposalAgentSystemPrompt`，prompt 软闸门：Agent 陈述变更并征得用户明确同意后提交，提交直通 repository）。流式渲染 + 思考折叠展示（依赖 19）+ 工具调用参数/结果展开 + 取消 + 复制回答 + 按（空间 × 模式）页面内存历史 + 运行中空间切换安全处理。

**Blocked by:** 19（思考流适配器）

**Status:** ready（grilling 2026-08 确认，待实现）

## 已确认决策（grilling 2026-08）

1. **入口（Q5）**：面板底部新 Tab「问答」（底部 Tab 变 6 个），内部「查询 / 填写」模式切换（对齐 api/web 决策 11 的 UI 标签「查询/填写」）；提供「复制回答」；不做「发送到对话」。
2. **定位（Q1/Q4）**：用户功能 + 调试工具兼得；v1 纯记忆问答——查询/填写都不附剧情/对话上下文（零注入，对齐 api/web 决策 9），"把刚才的对话记下来"走后台填表任务。
3. **闸门（Q6）**：prompt 软闸门（对齐 api/web 决策 4），无 UI 硬闸门；提交 = 直通 repository 不经活动任务守卫（web 决策 8），`revisionSource = "agent"`（web 决策 10），core 修订校验（expectedRevisionId）兜底并发。
4. **历史（Q7/Q9）**：页面内存，按（空间 × 模式）各存独立历史；刷新即失；不落 Dexie、不进通用日志。
5. **提示词（Q8）**：core 固定 composer，Agent 提示词预设档案保持填表任务专用（ADR 0006 不扩展）。
6. **思考流（Q3/Q14）**：适配器 `includeReasoning: true`（ticket 19 的选项）；思考块折叠展示；模型不支持时静默降级。
7. **空间切换（Q11）**：运行中切换对话——查询模式继续对起始空间跑完（digest 构建于 run 起始）；填写模式在 `submit_proposal` 提交前校验当前绑定空间 == run 起始空间，不一致则放弃提案并提示「对话已切换，变更未提交」（对齐填表任务 chatId 安全点精神）。
8. **取消与超时**：AbortController，适配器以 stopReason "aborted" 收尾；单次 run 总超时 5 分钟（core 默认）。
9. **多轮历史**：无状态回传（11.5 落定项）——回传 user/assistant 文本消息，工具结果与思考块不跨轮回传。
10. **提交后不自动刷新**记录视图，面板提供「刷新」入口（web 决策 7）。
11. **LLM**：复用 `createStLlmPort`（ST backends，用户当前生成配置），无配置表单；未绑定空间显示空状态邀请。

## 结构

```
apps/st-extension/src/query-chat/
├── query-chat-state.ts     # 纯逻辑 seam：按（空间×模式）消息历史、模式、run 状态（可取消/终止）
├── query-chat-service.ts   # run 编排：装配 QueryAgent / ProposalAgent（llm 端口 includeReasoning=true）、
│                           #   事件 → 状态增量（thinking/text/toolcall/终态）、填写提交与空间校验、历史组装
└── *.test.ts
```

- `ui/`：问答 tab（聊天渲染、思考折叠、工具调用展开/收起、模式切换、刷新入口、复制、空状态）
- `ui/panel-model.ts`：PanelTab 加 "query"（PANEL_TABS 六个）
- `llm/st-backends-llm.ts`：构造 llm 端口时 `includeReasoning: true`（依赖 19）
- 空间切换守卫：读取当前绑定空间（复用 fill-task chatId 先例）

## 验收（手动）

1. 查询模式提问 → 流式回答；工具调用参数/结果实时可见可展开；思考模型有折叠思考块
2. 填写模式：「记一下：XX 现在穿红衣服」→ Agent 陈述变更并征求同意 → 用户明确同意 → 提交 → 已提交摘要；点「刷新」后记录视图可见
3. 用户回复「不同意」→ 不提交、Agent 直接结束
4. 提问中可停止；网络/鉴权/超时/取消有明确提示且不阻塞继续操作
5. 运行中切换对话：查询模式继续跑完；填写模式提交被拦截并提示「对话已切换，变更未提交」
6. 切换空间/模式历史各自独立；刷新页面后清空；未绑定空间显示空状态邀请
7. 复制回答可用

## Comments

- 2026-08 grilling（grill-with-docs）确认：Q1=C（功能+调试）、Q2=B（双模式）、Q3=B（思考流）、Q4=A（纯记忆）、Q5=A（新 Tab）、Q6=A（软闸门）、Q7=A（内存历史）、Q8=A（固定提示词）、Q9=A（不落日志）、Q10=A（零注入）、Q11=A（提交前校验）、Q12=B（拆两票）、Q14=B（按消费者开思考流）。ADR 0009 + core CONTEXT.md「查询 Agent」+ st-extension CONTEXT.md「问答面板」已落；spec.md 决策 15 + 故事 48-50 + Out of Scope 调整。
