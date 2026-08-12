# 世界书占位符：委托 ST 扫描，不实现匹配逻辑

填表 Agent 的提示词完全看不到世界观（块提示词只有原始消息，ST 主提示词的世界书注入不进入 Agent 请求）。Agent 提示词预设（ADR 0006）新增占位符 `{{worldbook}}`：任务提交时把任务范围剧情文本（`名字：内容` 逐行拼接）**包成单条合成消息**交给 ST 自己的扫描器（`getContext().getWorldInfoPrompt(chat, maxContext, isDryRun)`），展开为已激活条目的原文（worldInfoString）。扫描在提交时执行一次，文本快照进 composer（与 `{{user}}/{{char}}` 快照同模式），composer 保持同步签名，core 零改动；无世界书、无匹配、旧版 ST 或扫描失败 → 展开为空串，不阻断任务。不注册 ST 全局宏（主提示词已注入世界书，宏会重复）。

**委托而非自研**：生效书本选择（全局/角色/对话书、群聊策略）与全部匹配规则（关键词+正则、constant/selective、概率、预算截断、角色过滤）都在 ST 内部——`globalSelect` 不在 getContext() 里，自研匹配还要经 `/api/settings/get` 补作用域并复刻群聊策略，且必然与主提示词激活集漂移。单条消息的合成 chat 让深度/递归/最小激活数等规则自动退化为平凡情形——「复杂规则不用管」的代价为零。

**dry run 是强制约束**：非 dry run 的扫描会写 `chat_metadata.timedWorldInfo`（sticky/cooldown 时间戳按传入 chat 长度计算），用 1 条合成消息会污染真实对话的定时状态；dry run 只读不写。

**不选方案**：插件自研 substring 匹配（书本作用域复杂度 + 与主提示词漂移，见上）；每个块分别扫描（composer 同步闭包需可变持有器或每块重建 Agent，服务装配复杂，收益不明——任务内 chat 不变，提交时一次扫描即稳定）；`{{worldbook}}` 注册为 ST 全局宏（与主提示词注入重复；宏 handler 必须同步，匹配结果随每条消息变化，需事件/轮询重建快照）。
