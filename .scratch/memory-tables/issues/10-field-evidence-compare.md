# 10 — 保存字段级证据并支持原始聊天对比

**Type:** task

**What to build:** 将记录字段值与来源消息建立证据关联，支持 Adapter 选择 snapshot 或 reference 保存策略，并在工作区右侧展示字段证据、历史值和原始聊天跳转。

**Blocked by:** 09 — 提供统一的 query_records 查询能力

**Status:** resolved

- [x] 每个字段证据具有 Core 生成的内部 `evidence_id`。
- [x] snapshot 模式保存必要的来源内容和来源元数据。
- [x] reference 模式只保存 `source_type`、`source_id`、`extraProps` 等定位信息，完整消息从 HTTP Source Store 读取。
- [x] 证据 DTO 不再依赖 `speaker`、`occurred_at` 或 `external_locator`，Adapter 元数据写入 `extraProps`。
- [x] 手动无来源记录可正常保存，并在界面标记为无证据。
- [x] 右侧检查器能按字段显示证据、值来源、revision，并点击跳转到原始消息。
- [x] 原始聊天查看器能高亮当前证据消息，来源不存在时显示明确缺失状态。

## Answer

已完成字段级证据模型、SQLite 持久化与 HTTP DTO，支持 snapshot 和 reference 两种保存策略，并以来源类型和来源 ID 复用证据身份。记录更新会清除被手动改写字段的旧证据，记录历史保留修改前的字段证据。

工作区右侧检查器按字段显示证据、来源和 revision；点击来源可跳转并高亮原始消息，来源缺失时展示明确状态，手动字段显示无证据。完整类型检查、lint、格式检查、70 项测试与构建通过；浏览器验收覆盖桌面、移动端、消息跳转和缺失来源状态。
