# 10 — 保存字段级证据并支持原始聊天对比

**Type:** task

**What to build:** 将记录字段值与来源消息建立证据关联，支持 Adapter 选择 snapshot 或 reference 保存策略，并在工作区右侧展示字段证据、历史值和原始聊天跳转。

**Blocked by:** 09 — 提供统一的 query_records 查询能力

**Status:** ready-for-agent

- [ ] 每个字段证据具有 Core 生成的内部 `evidence_id`。
- [ ] snapshot 模式保存必要的来源内容和来源元数据。
- [ ] reference 模式只保存 `source_type`、`source_id`、`extraProps` 等定位信息，完整消息从 HTTP Source Store 读取。
- [ ] 证据 DTO 不再依赖 `speaker`、`occurred_at` 或 `external_locator`，Adapter 元数据写入 `extraProps`。
- [ ] 手动无来源记录可正常保存，并在界面标记为无证据。
- [ ] 右侧检查器能按字段显示证据、值来源、revision，并点击跳转到原始消息。
- [ ] 原始聊天查看器能高亮当前证据消息，来源不存在时显示明确缺失状态。
