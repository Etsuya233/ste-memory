# 17 — Agent 提示词预设（填表 Agent 预设）

**What to build:** 填表 Agent（ProposalAgent）系统提示词的预设体系：全局预设列表（extension_settings），预设 = 命名档案，内含**片段**（命名 + 内容 + 开关 + 排序）；内置只读「系统默认预设」；全局**活动预设**；任务 Tab 触发处快捷切换。**模板模式**：最终 system prompt = 启用片段按序拼接 → 占位符展开，**不自动追加 digest**（占位符显式引用）。core / api / web **零改动**（`ProposalAgent` 既有 `composeSystemPrompt` 注入点，插件侧装配时注入；用户决策 2026-08-11 grilling 确认）。

**Blocked by:** 无（复用 13 触发链路、06 设置 UI、12 LLM 路径、15 宏注册先例，均已 resolved）

**Status:** resolved

## 已确认决策（grilling 2026-08-11）

1. **模型（ADR 0006）**：双层——预设 = 命名档案（含片段列表），切换活动预设 = 换整套片段组合；预设列表本身可拖拽排序（展示性）；「系统默认」= 内置只读预设（固定 id，可查看、可「复制为自定义」，不可改不可删）。
2. **覆盖语义 = 模板模式**：预设文本不自动附加 digest；`{{tablesDigest}}` / `{{systemDefaultPrompt}}` 显式引用。自定义预设保存时若既不含 `{{tablesDigest}}` 也不含 `{{systemDefaultPrompt}}` → 编辑器提示一次（Agent 失去表/字段摘要、工具可用性下降），**不拦**。
3. **存储与作用域**：全局列表 + 全局活动预设，存 `extension_settings.steMemory.agentPresets`（mergeSettings 补默认，旧数据无缝迁移）；不做 per-space。
4. **占位符白名单（自研展开，不接 ST MacroEngine，ADR 0006）**：`{{user}}`（name1）、`{{char}}`（单角色 name2 / 群聊=群名）、`{{tablesDigest}}`（run 时 digest 摘要现算，无需预计算快照）、`{{systemDefaultPrompt}}`（默认提示词全文含 digest）；**未知占位符原样保留**。user/char 值在任务提交时从 getContext 快照（对话切换守卫保证任务内 chat 不变）。
5. **ST 宏注册**：`{{tablesDigest}}` / `{{systemDefaultPrompt}}` 注册为 ST 全局宏（macros.register，与记忆宏同模式）；不注册 user/char（与 ST 内建宏重名）。
6. **UI**：设置 Tab 新分区「Agent 提示词预设」——预设列表（新建/复制/删除/导入/导出/拖拽排序）+ 片段编辑器（卡片内联展开 textarea、开关、拖拽排序、占位符插入 chips、命名可选空回退内容首行）；任务 Tab 触发处「当前预设」下拉快捷切换（写 settings，不打断破限流程）。
7. **导入导出**：每预设 JSON，备份信封模式 `{ format: "ste-memory-agent-preset", version: 1, ... }`，未知版本明确报错绝不半导入；导入重名自动改名（原名 (2)）不覆盖。
8. **边界**：删除活动预设 → 回退「系统默认」；「复制单个预设」= 复制为完整新预设（含片段与开关状态），编辑器另提供「复制全文」按钮。
9. **可见性**：任务 Tab 显示当前活动预设名（全局值，**任务行不加快照字段**，避免 Dexie schema 变更）；调试时 console 输出最终 system prompt。
10. **不做**（记录）：`{{group}}` 占位符；任务行预设快照；MacroEngine 接入；per-space 预设；digest 自动追加；预设 JSON 批量导入导出（v1 只做单预设）。

## 结构

```
apps/st-extension/src/agent-presets/
├── preset-model.ts          # 纯逻辑 seam：形状/CRUD/开关/排序/复制/导入导出信封校验/重名改名
├── preset-composer.ts       # 占位符展开组合器（digest + 提交时快照的 names → 最终 system prompt）
└── *.test.ts
```

- `settings/plugin-settings.ts`：`+ agentPresets: { presets: [...], activePresetId }`（mergeSettings 兼容）
- `fill-tasks/fill-task-service.ts`：`+ composeSystemPrompt` 注入（任务开始时读设置 + 快照 names）
- `st/st-chat-adapter.ts`：StContext `+ name1`（+ 群名经 groups 推导）
- `ui/`：设置 Tab 预设管理器 + tasks-tab 快捷切换下拉
- `runtime.ts`：装配 composer 与预设模型

## 验收（手动）

1. 预设 CRUD：新建/复制/删除/重命名；系统默认只读（不可删不可改）、可「复制为自定义」；删除活动预设回退系统默认
2. 片段：开关只影响启用片段、拖拽排序反映在最终提示词顺序、命名空回退首行、占位符 chips 插入
3. 模板模式：活动预设 = 自定义（含 `{{user}}/{{char}}/{{tablesDigest}}`）触发填表任务 → 记录正常落库（digest 生效）；不含 digest 引用的预设保存时收到提示
4. 群聊触发：`{{char}}` 展开为群名；未知占位符（如 `{{typo}}`）原样出现在最终提示词
5. 任务 Tab：下拉快捷切换预设后触发，任务卡显示预设名；console 可见最终 system prompt
6. 导入导出：导出单预设 JSON → 清空重导 → 重名自动改名、未知 version 明确报错不半导入

## Comments

- 2026-08-11 grilling（grill-with-docs）确认设计；ADR 0006 + CONTEXT.md 术语（Agent 提示词预设/片段/系统默认预设/活动预设）已落。
- 2026-08-11 实现完成（26 个文件）：core 仅导出（`composeTableDigestSummary`/`PROPOSAL_AGENT_BASE_INSTRUCTIONS`，行为零变化）；新 `agent-presets/`（preset-model/preset-composer/agent-macro-service + 测试）；fill-task-service 注入 `createComposeSystemPrompt`（提交时快照 names + 预设文本，首次组合 log system prompt）；runtime 接线（composer 工厂 + AgentMacroService 注册两个 ST 宏 + 开关 kick）；设置 Tab 预设管理器（dnd-kit 拖拽排序片段与预设列表、占位符插入 chips、digest 缺失常驻提示、导入导出信封、复制为自定义/复制全文）；任务 Tab 快捷切换下拉。测试：st-extension 518/518（+51 新）、core 178/178、typecheck（src+scripts）/eslint/build 全绿；全仓并行 9 failed 与基线一致（预存并行 flaky，单独跑全部通过）。拖拽用 @dnd-kit（用户指定）。
- 2026-08-11 code-review（双轴并行）结论：Standards 无硬违规；Spec 1 缺失（预设列表拖拽排序 D6）+ 1 偏差（常驻提示 vs 提示一次，保留常驻）。采纳修复：①预设列表拖拽排序（moveAgentPreset + 管理区列表替换下拉）；②导入 id 冲突循环重分配；③占位符/宏名单一来源（AGENT_PRESET_PLACEHOLDERS 派生宏名与匹配模式）；④轮询骨架抽取共享 PollingEvaluator（记忆宏 + Agent 预设宏复用）；⑤spec.md 编号冲突修复。未采纳（判断级）：全片段禁用 → 空 system prompt 保持（ADR 用户完全控制）。
- 遗留：真机验收（第 3/4/5 条）待用户在真实 ST 环境执行。
