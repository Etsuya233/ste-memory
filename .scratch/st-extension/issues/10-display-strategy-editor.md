# 10 — 显示策略编辑器

**What to build:** 表格显示策略配置：指定短文本显示字段，或基于字段的派生显示模板；显示策略依赖的字段不能直接删除；记录列表按显示策略渲染显示文本（与 core 显示策略规则一致）。

**Blocked by:** 09 — 自定义表创建与字段定义编辑器

**Status:** resolved

- [x] 两种策略（短文本字段 / 派生模板）均可配置并保存
- [x] 显示策略依赖的字段删除被阻止并提示
- [x] 记录列表按显示文本渲染正确

## Answer

工作树提交（12 文件，+520 左右；core 预览 3 例 + st-extension seam/冒烟 19 例，全仓 578/578 绿，typecheck 全绿，prettier 门禁通过）。

- **core（增量）**：`MemoryRecordService.previewDisplayText(spaceId, tableId, strategy, payload)` 只读预览——以给定策略经 `computeMemoryRecordDisplayText` 计算显示文本，策略合法性校验与 `setDisplayStrategy` 同语义（违规抛 `memory_table_display_strategy_invalid`，避免无效草稿模板使预览崩溃）；`derivedDisplayTemplate`/`memoryTableDisplayFieldIds` 加入 core 导出。带单测（core/test/memory-record-display-preview.test.ts）。
- **runtime**：`records`（MemoryRecordService 完整实例）接入 SteMemoryRuntime + PanelRuntime 端口（ticket 11 本来需要，先行接线）。
- **策略编辑器（`src/ui/display-strategy-editor.tsx` + `display-strategy-model.ts`）**：表格卡片「显示策略」入口；类型选择（显示字段/显示模板）；字段下拉仅列启用 short_text 字段（无可用字段时禁用提示）；模板输入 +「插入字段引用」chip（`{fieldId}` 插到光标处）；草稿校验与 core 同规则（双保险，core 抛错 toastr 兜底）；保存走 `fields.setDisplayStrategy`。卡片 meta 行显示策略摘要。
- **依赖保护**：策略依赖字段列表角标「显示策略依赖」+ 启停/删除按钮禁用（core `memory_field_used_by_display_strategy` 编程路径兜底，双保险）；verify-ui-shell.mjs §6 同步改为断言开关禁用（脚本与组件同步演进）。
- **实时预览（验收③验证点）**：编辑器内「显示效果预览」最多 5 条现有记录，按草稿策略经 core `previewDisplayText` 现算显示文本逐行渲染（字段值摘要 + 显示文本），无记录时空状态文案。完整记录列表 tab = ticket 11。

## Comments

- 2026-08-09 code-review（双轴并行）结论：无硬违规。Standards 判断级采纳三条：①`.stm-strategy-chip` 触控高度 36px→44px（spec §11 ≥44px，chip 可点按插入引用）；②`data-action="display-strategy-save"` 改名 `editor-submit` 与既有编辑器词表一致（组件+冒烟同步）；③`displayStrategyDependentFieldIds` 渲染期防御畸形策略（无占位符模板，仅畸形备份恢复可能带入）——降级空集合不阻断显示。未采纳（判断级）：策略校验规则三处拷贝（core setDisplayStrategy / previewDisplayText / UI seam）——core 侧为抛错式 API、UI 侧需即时反馈文案，有意双保险，注释已记录演进风险；verify-ui-shell.mjs 未新增驱动策略保存流程——真机脚本统一归 ticket 11 的 verify-record-crud.mjs 覆盖。
- **跨票注意事项（ticket 11 必读）**：core `setDisplayStrategy` 只改表策略、**不重算既有记录存储的 displayText**——ticket 11 记录列表若直接渲染存储 displayText，策略变更后显示会过期。协调者决策：列表显示文本按**读时计算**（`previewDisplayText(表当前策略, record.payload)`），保证与 core 规则一致。
