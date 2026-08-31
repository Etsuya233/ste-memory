# 01 — 片段时间线状态模型

**What to build:** 问答面板的 assistant 消息从「思考/文本/工具调用各自合并」的扁平字段改为按真实发生顺序排列的「片段序列」：思考增量与文本增量合并进当前同类型片段、类型一切换就开新片段，工具调用在发生位置插入卡片、结果按 callId 回填；聚合回答纯文本由文本片段推导（回传历史与复制按钮继续使用，行为不变）。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] 交错事件序列（思考 → 文本 → 工具开始 → 工具结果 → 思考 → 文本）产出顺序正确的片段序列，工具调用卡出现在触发位置且结果回填到同一张卡
- [x] 相邻同类型增量合并进同一片段；类型切换开启新片段；被工具调用隔开的多段思考各自独立
- [x] 聚合回答纯文本 = 全部文本片段拼接；streaming/error 消息不回传历史的既有行为不变
- [x] 无思考事件时消息不含思考片段（模型不支持思考的静默降级）；未知/迟到 callId 的 tool_result 不产生新条目
- [x] 纯逻辑状态 seam 的既有单测全绿，新增用例覆盖本票全部规则（事件序列 → 片段序列断言，无 React 依赖）

**Status:** resolved

## Answer

`query-chat-state.ts`：assistant 消息扁平字段（thinking/text/toolCalls）替换为有序 `segments` 序列（唯一事实来源）。`appendDelta` 实现构建规则——增量追加进末端同类型片段、类型切换开新片段；`tool_start` 在时间线当前位置插入独立 tool 卡（含显式 `running` 执行中标记，`tool_result` 到达置 false，避免合法 `undefined` 结果卡死「执行中」）；`tool_result` 按 callId 回填结果/错误，未知/迟到 callId 原样返回不产生新条目。聚合回答纯文本由 `assistantPlainText`（文本片段拼接）推导，回传历史与复制按钮行为不变。单测 23 个全绿：交错保序（思考→文本→工具→结果→思考→文本）、同类型合并、被工具隔开的多段思考独立、多卡各自回填、undefined 结果收尾、未知 callId no-op、无思考静默降级、纯文本拼接、终态/错误语义。