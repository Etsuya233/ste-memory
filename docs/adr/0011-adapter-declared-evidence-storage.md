# 由适配器声明证据存储模式

适配器为导入的证据传入存储模式枚举。`snapshot` 在 Core 中保存 `content` 和完整规范化元数据；`reference` 在 Core 中只保存 `source_type`、`source_id` 和 Adapter 提供的 `extraProps`，完整消息由 Adapter Source Store 持有。领域层不推断来源的持久化策略，也不依赖 SillyTavern 的消息模型。
