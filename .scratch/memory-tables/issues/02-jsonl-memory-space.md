# 02 — 上传 JSONL 并创建可浏览的记忆空间

**Type:** task

**What to build:** 实现创建记忆空间的网页流程。用户必须上传 JSONL，HTTP Adapter 解析每行消息并写入自己的 Source Store，同时创建按会话隔离的 Memory Space；用户可以浏览原始聊天数据，但不会自动触发 Agent。

**Blocked by:** 01 — 建立可运行的本地实验骨架

**Status:** ready-for-agent

- [ ] 创建请求没有 JSONL 文件时明确失败，不创建半成品记忆空间。
- [ ] JSONL 解析保留稳定的 `source_type`、1-based `source_id`、消息内容和 Adapter 的 `extraProps`。
- [ ] 无法解析的行被记录为可见错误，成功行不会被静默丢弃。
- [ ] Source Store 保存完整消息；Core 只保存后续需要的空间和来源定位信息。
- [ ] 页面支持记忆空间列表、创建、重命名和删除。
- [ ] 原始聊天查看器按 1-based `source_id` 显示消息，并能定位到消息。
- [ ] 创建空间后不会自动运行表格填写 Agent。
