# 01 — 可配置面板入口（顶部导航栏 / 底部魔法棒 / 两者）

**What to build:** 一张票做完整条小需求（spec：`.scratch/panel-entry/spec.md`）：设置项 + 挂载控制器 + 设置分组 UI 三位一体。插件全局设置新增 `entryPlacement: "top" | "wand" | "both"`（默认 `"top"`，mergeSettings 前向兼容）；挂载控制器按设置解析挂载目标——top 保持现状（#top-settings-holder 兜底 body），wand/both 等待 `#extensionsMenu` 出现后追加「记忆面板」行条目（镜像内置工具行结构 `div.list-group-item.flex-container.flexGap5` + icon + span，先例 gallery addGalleryWandButton），容器始终不可用则回退顶部并标记 fallback；设置 Tab 低频区新增「面板入口」折叠分组（三个选项 + 实际挂载位置提示 + 折叠态摘要），切换即时生效。

**Blocked by:** None — can start immediately

**Status:** resolved

- [x] `PluginSettings.entryPlacement`（默认 `"top"`）落地，旧设置数据 merge 自动补齐默认值，不破坏已有设置读写（单测覆盖）
- [x] 挂载决策纯逻辑 seam：top → 顶部；wand → 魔法棒；both → 两处；魔法棒容器缺失/始终未出现 → 回退顶部 + fallback 标记（单测覆盖，无 React/DOM 依赖）
- [x] 魔法棒项挂载：等待 #extensionsMenu 出现（MutationObserver/短轮询），追加可见行条目（我们的项是可见子项，魔法棒按钮随之亮出），点击 toggle 面板、展开态高亮
- [x] 切换设置即时生效：重解析 + 重挂载（React 双 root 沿用 mountPanel 风格），无需重启
- [x] 「面板入口」设置分组：折叠 + 摘要行（当前选择 + 回退时「实际位置：顶部（魔法棒不可用）」），与安全区/版本分组同区
- [ ] 人工验收：真机 ST 桌面 + 移动断点，三个选项 × 面板开关往返各过一遍；魔法棒入口行随 ST 菜单原生样式无错位（待真机）

## Answer

已实现（2026-09 发版准备）：

- **设置模型** `src/settings/plugin-settings.ts`：`EntryPlacement = "top" | "wand" | "both"` + `DEFAULT_SETTINGS.entryPlacement: "top"` + `mergeSettings` 校验补齐（非法值回退 top，旧数据自动补默认）。
- **纯逻辑 seam** `src/ui/entry-placement.ts`（新）：`planEntryMount`（placement × 魔法棒就绪度 → `{top, wand, fallback}`，未就绪统一回退顶部）、文案（选项标签/分组摘要含「已回退顶部」标记/实际位置提示）、`createEntryPlanStore`（计划发布 + 订阅，供挂载控制器写、设置分组读）。
- **挂载控制器** `src/ui/st-panel-host.tsx`：`EntryMountController` 实现 `EntryMountControllerPort`（getPlan/onPlanChange/replan）——按 `entryPlacement` 热切换顶部按钮（#top-settings-holder 兜底 body）与魔法棒项（`#extensionsMenu`，等待窗口 15s：MutationObserver + 超时回退），`replan()` 由设置分组写入后调用即时生效。
- **UI** `src/ui/panel-shell.tsx`：`WandEntry`（镜像 ST 内置工具行 `list-group-item flex-container flexGap5` + `extensionsMenuExtensionButton`，aria-pressed 展开态）；设置 Tab 新增折叠分组 `data-group="entry"`（面板入口，位于「版本与运行状态」与「面板安全区」之间），三选项按钮 + 回退提示行 + 折叠摘要；`PanelRuntime.entryMount?` 可选端口（测试 fake 缺省用默认计划）。
- **折叠持久化** `src/ui/settings-collapsed-model.ts`：`SETTINGS_GROUP_KEYS` 新增 `"entry"`（version 与 safe-area 之间）。
- **样式** `src/style.css`：`.stm-wand-entry` 按压/展开态与焦点高亮（--stm-* 令牌，布局零新样式）；`.stm-entry-option` 三选一按钮。
- **测试**：`entry-placement.test.ts`（新，挂载决策表 + 文案 + 存储订阅）、`plugin-settings.test.ts`（merge 补齐/非法回退/完整合法往返）、`panel-shell.test.tsx`（WandEntry 投影、分组折叠/摘要/回退提示、分组顺序）；全量 987 通过，typecheck/lint/build 干净。
- **人工验收**（验收脚本/真机，未做）：真机 ST 桌面 + 移动断点三选项 × 面板开关往返；魔法棒按钮被入口项点亮后随 ST 原生样式无错位。
- 上下文指针：词条「面板入口」已入 `apps/st-extension/CONTEXT.md`（与 grill 会话决策一致，无 ADR）。

## Answer

（实现后填写：落地文件、测试结果、验收结论）