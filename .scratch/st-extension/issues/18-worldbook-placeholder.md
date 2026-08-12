# 18 — 世界书占位符（Agent 预设 {{worldbook}}）

**What to build:** Agent 提示词预设新增占位符 `{{worldbook}}`：任务提交时把任务范围剧情文本（`名字：内容` 逐行拼接，楼层升序）**包成单条合成消息**委托 ST 扫描（`getContext().getWorldInfoPrompt(chat, maxContext, isDryRun=true)`），展开为已激活世界书条目的原文（worldInfoString）。扫描提交时一次、文本快照进 composer（与 `{{user}}/{{char}}` 同模式）；无世界书/无匹配/旧版 ST/扫描失败 → 展开空串，不阻断任务。不注册 ST 全局宏。

**Blocked by:** 17 — Agent 提示词预设（resolved）

**Status:** resolved

## 已确认决策（grilling 2026-08-12）

1. **作用域**：只进 `AGENT_PRESET_PLACEHOLDERS` 白名单（chips/展开器/模式自动跟随，单源）；**不**注册 ST 全局宏（主提示词已注入世界书，宏会重复；宏 handler 必须同步而匹配结果随消息变化）。
2. **匹配实现（ADR 0007）**：委托 ST 扫描——`getWorldInfoPrompt([合并文本], maxContext, true)`；插件零匹配代码，不违反隔离策略（只经 getContext 适配器）。生效书本选择、关键词+正则、constant/selective、概率、预算截断全由 ST 处理；单条消息下深度/递归/最小激活数自动退化。
3. **合并粒度**：整个任务范围（from..to）提交时合并成一段、扫描一次、快照进 composer；**非**每块重扫。合并形态 = `名字：内容` 逐行换行（楼层升序，不带 `[floor]`；无名消息裸内容）。
4. **输出**：原样 `worldInfoString`；不加插件侧上限设置（ST budget 已约束）。
5. **空值与降级**：无世界书/无匹配/旧版 ST 无 `getWorldInfoPrompt` → 空串；扫描抛错 → 空串 + warn 日志，不阻断任务；未知占位符仍原样保留。
6. **附加匹配字段**：globalScanData 用 ST 默认（trigger='normal'，角色描述/场景等不参与匹配）——只有剧情文本参与。
7. **装配**：`createComposeSystemPrompt` 改为异步、接收合并剧情文本；composer 保持同步、`#runTask` 循环零改动、core 零改动；预设不含 `{{worldbook}}` 引用 → 不触发扫描（零开销）。dry run 强制（非 dry run 的定时效果会写 chat_metadata，污染真实对话状态）。

## 结构

- `agent-presets/preset-composer.ts`：白名单 `+ worldbook`；`composePresetSystemPrompt(presetText, names, worldbookText)` 加参；`PLACEHOLDER_HINTS` 说明文案（chip title）
- `agent-presets/worldbook-text.ts`（新，纯逻辑）：`buildMergedStoryText(messages)` + `scanWorldbookText(context, text)`（缺函数 → 空串；dry-run 调用）
- `agent-presets/preset-model.ts`：`containsWorldbookReference(preset)`（仿 containsDigestReference，停用片段不算）
- `fill-tasks/fill-task-service.ts`：`createComposeSystemPrompt` 异步化 + 提交时构建合并文本（有工厂才构建）
- `runtime.ts`：装配——预设含 `{{worldbook}}` → 扫描（异常 → warn + 空串）→ 快照进 composer
- `st/st-chat-adapter.ts`：StContext `+ getWorldInfoPrompt?` / `maxContext?`（可选 = 版本守卫）
- `ui/agent-preset-manager.tsx`：chips 自动出现（白名单单源）+ title 提示
- 测试：preset-composer（展开/空串/单遍）、worldbook-text（合并格式/dry-run 调用形态/缺函数降级）、preset-model（引用检测）、fill-task-service（异步工厂收到合并文本）
- 文档：ADR 0007 + CONTEXT.md 术语（世界书 / 世界书占位符）

## 验收（手动）

1. 预设含 `{{worldbook}}` 触发填表任务 → 最终 system prompt 中出现与剧情匹配的世界书条目内容（console 可见）
2. 剧情提及某条目的关键词 → 该条目内容出现；不提及 → 不出现；constant 条目始终出现
3. 无世界书/无匹配 → `{{worldbook}}` 展开为空（不留占位符原文）
4. 群聊任务：世界书匹配正常（生效书本选择与 ST 主提示词一致）
5. `chat_metadata.timedWorldInfo` 在任务前后不变（dry run 生效，不污染定时状态）
6. 未知占位符（如 `{{typo}}`）仍原样保留

## Comments

- 2026-08-12 grilling（grill-with-docs）确认设计；ADR 0007 + CONTEXT.md 术语已落。
- 2026-08-12 实现完成（TDD 红绿循环）：
  - `agent-presets/preset-composer.ts`：白名单 `+ worldbook`（chips/展开器/模式单源自动跟随）；`AGENT_PRESET_PLACEHOLDER_HINTS`（chip title 悬停说明）；`composePresetSystemPrompt(presetText, names, worldbookText)` 加参（提交时快照）；expander 原样插入，空快照 → 空串，单遍语义不变（快照内 {{user}} 不二次展开）。
  - 新 `agent-presets/worldbook-text.ts`（纯逻辑）：`scanWorldbookText`（单条合成消息 + dry run 调用 ST `getWorldInfoPrompt`；旧版 ST 无函数 → 空串）。合并文本构建 `buildMergedStoryText` 归 `fill-tasks/fill-task-block.ts`（消息格式化职责归 fill-tasks，避免跨模块双向依赖）。
  - `preset-model.ts`：`containsWorldbookReference`（启用片段才计）。
  - `fill-task-service.ts`：`createComposeSystemPrompt` 异步化（接收合并剧情文本，缺省 no-op 工厂返回 undefined → 核心默认组合器）；composer 保持同步，`#runTask` 循环零改动。
  - `runtime.ts`：装配——预设含 `{{worldbook}}` 才扫描（零引用零开销）；扫描失败 → warn + 空串，不阻断任务。
  - `st-chat-adapter.ts`：StContext `+ maxContext?` / `getWorldInfoPrompt?`（可选 = 版本守卫，降级空串）。
  - `ui/agent-preset-manager.tsx`：chips 自动出现 + title 提示（白名单单源）。
  - 测试 +12：worldbook-text 6（合并格式/顺序/空数组、dry-run 调用形态 `([文本], maxContext, true)`、缺函数降级、空结果）、preset-composer 4（展开/空串/单遍/快照携带）、preset-model 1（引用检测）、fill-task-service 1（工厂收到合并文本并展开进 system prompt）。
  - 验证：st-extension 530/530、typecheck/lint（改动文件零新增问题）/prettier 全绿；全仓并行 5 failed 与基线一致（apps/api 预存并行 flaky，单独跑全部通过）。
  - 遗留：真机验收（手动清单 1–6）待用户在真实 ST 环境执行。
