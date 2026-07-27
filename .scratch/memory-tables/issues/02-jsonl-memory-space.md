# 02 — 上传 JSONL 并创建可浏览的记忆空间

**Type:** task

**What to build:** 实现创建记忆空间的网页流程。用户必须上传 JSONL，HTTP Adapter 解析每行消息并写入自己的 Source Store，同时创建按会话隔离的 Memory Space；用户可以浏览原始聊天数据，但不会自动触发 Agent。

**Blocked by:** 01 — 建立可运行的本地实验骨架

**Status:** resolved

- [x] 创建请求没有 JSONL 文件时明确失败，不创建半成品记忆空间。
- [x] JSONL 解析保留稳定的 `source_type`、1-based `source_id`、消息内容和 Adapter 的 `extraProps`。
- [x] 无法解析的行被记录为可见错误，成功行不会被静默丢弃。
- [x] Source Store 保存完整消息；Core 只保存后续需要的空间和来源定位信息。
- [x] 页面支持记忆空间列表、创建、重命名和删除。
- [x] 原始聊天查看器按 1-based `source_id` 显示消息，并能定位到消息。
- [x] 创建空间后不会自动运行表格填写 Agent。

## Comments

- Core 新增平台无关的记忆空间模型与应用服务，Core SQLite 保存空间身份和名称；HTTP Source Store 独立保存会话映射、完整消息及逐行解析错误。
- HTTP API 支持 multipart JSONL 创建、列表、重命名、删除、消息读取和错误读取；缺少文件与全文件无有效消息时不会创建空间。
- React 页面支持完整管理流程、解析错误展示和 `source_id` 定位高亮；上传只持久化数据，没有 Agent 调度入口或隐式运行逻辑。
- `pnpm typecheck`、`pnpm lint`、`pnpm test` 和 `pnpm build` 通过；浏览器覆盖创建、部分坏行导入、消息定位、重命名、删除及移动端布局。
