# 02 — 时间线渲染、折叠压缩与回答 Markdown

**What to build:** 问答面板按片段时间线渲染一条 Agent 回复——思考片段（可折叠）、文本片段（Markdown 渲染）、工具调用卡各自出现在时间线的对应位置，呈现「思考 → 输出 → 调用 → 结果 → 再思考」的原始节奏。折叠语义：流式中仅正在进料的片段强制展开，已完成片段默认折叠、手动展开后不被自动收回，工具卡执行中展开、出结果后折叠；失败卡错误高亮。文本片段用 react-markdown + remark-gfm 渲染（打进 esbuild bundle）：表格窄面板内横向滚动、外链新标签页打开、回答内原始 HTML 默认转义不执行；思考片段保持纯文本、工具参数与结果保持 `<pre>` JSON。同时压缩折叠态高度：思考块/工具卡 summary 的 44px min-height 收到 28px、卡片内距收窄、assistant 容器间距下调。

**Blocked by:** 01 — 片段时间线状态模型（已随 01 完成）

**Status:** resolved

- [x] 时间线按片段顺序渲染：多个思考片段各自独立成块、工具调用卡出现在它触发的那段内容之后、结果仍在卡内
- [x] 流式中仅当前进料片段受控展开；已完成片段默认折叠，且用户手动展开后不会被自动收回（已完成块不受控）
- [x] 工具卡执行中展开、完成后折叠；失败（isError）卡结果区错误高亮
- [x] 文本片段输出 GFM Markdown（标题/列表/代码块/表格）；思考片段仍为纯文本；工具参数与结果仍为 `<pre>` JSON
- [x] Markdown 表格窄面板内可横向滚动；外链新标签页打开；回答文本中的原始 HTML 不被执行
- [x] react-markdown + remark-gfm 加入插件依赖并随 esbuild 正常打包（构建通过）；容器样式使用插件设计 token，不移植 web 端样式
- [x] 「复制回答」仍复制纯文本（不带片段内标记），行为与之前一致
- [x] 折叠态压缩（summary 高度、卡片内距、容器间距）已按数值落实（人工验收由用户执行）；填表日志等其它区域的工具渲染不受影响（log-tab 独立渲染，零改动）
- [x] 渲染投影冒烟测试（react-dom/server renderToString，对齐既有先例）覆盖：片段 DOM 顺序、节点/class、折叠开合前提、复制按钮取纯文本、Markdown 冒烟渲染（给一段文本断言产出容器）

**Status:** resolved

## Answer

`ui/query-chat-tab.tsx`：`AssistantMessageView` 按 `segments` 顺序渲染时间线（`TimelineSegmentView` 三态投影）。折叠语义——仅末端进料思考片段受控展开（`open={isFeed}` + 进料 effect 在每次增量时重新断言展开，落实「流式期间手动折叠不生效」）；已完成思考片段不受控 details（默认折叠、手动展开不被收回）；工具卡 `open={card.running}` 由显式标记驱动（执行中展开、出结果后折叠），失败卡 `stm-chat-tool--error` + 结果区 `stm-chat-tool-section--error` 高亮。文本片段经 react-markdown + remark-gfm 渲染（外链 `target="_blank" rel="noreferrer"`、表格横向滚动包装、原始 HTML 默认转义），思考保持纯文本、工具 JSON 保持 `<pre>`；复制按钮按 `assistantPlainText` 取纯文本。`style.css`：summary min-height 44→28px、思考/工具卡内距 6px 10px→4px 8px、assistant 容器 gap 8→6px；新增 `--stm-*` token 的 Markdown 容器样式。依赖 react-markdown ^10.1.0 + remark-gfm ^4.0.1 进 package.json，esbuild bundle 验证含 remark-gfm 内部状态机。冒烟测试 11 个全绿（DOM 顺序、开合前提、undefined 结果折叠、JSON `<pre>`、GFM 结构、HTML 转义、错误/中止保留片段）。折叠压缩数值为人工验收项。