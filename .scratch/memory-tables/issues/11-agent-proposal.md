# 11 — 为选定消息范围生成 Agent 提案

**Type:** task

**What to build:** 接入 OpenAI-Compatible Tool Calling，为用户选定的一段 1-based 包含端点消息范围生成一个 Agent 提案。Agent 读取启用的表和字段 Prompt，通过只读查询工具分析来源，但本 Ticket 不直接写入正式表。

**Blocked by:** 10 — 保存字段级证据并支持原始聊天对比

**Status:** ready-for-agent

- [ ] 页面提供 Base URL、API Key、model 配置；空值时按字段回退服务端环境变量。
- [ ] API Key 只保留在当前页面内存中，不写数据库或 localStorage；非敏感配置可保存在浏览器。
- [ ] HTTP Adapter 将选定范围作为一个处理块传入 Application，范围包含起止消息且不会自动处理整段聊天。
- [ ] 当前版本不处理 max_token、前文尾部补齐或 ST Prompt 注入。
- [ ] 一个 Agent 覆盖该空间内所有启用的表和字段，组合默认/用户 Prompt 与来源消息。
- [ ] Agent 只能调用只读 `query_records`，不得绕过 Application 直接访问数据库。
- [ ] 输出是结构化可审阅提案，包含创建、更新、删除意图和每个字段的证据定位。
