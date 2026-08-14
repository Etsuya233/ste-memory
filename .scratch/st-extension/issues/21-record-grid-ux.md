# 21 — 记录网格填写体验改造（选择器 / 行高 / 查看-编辑模式 / 控件与单元格尺寸）

**What to build:** 记录 Tab 的表格填写体验升级，六项：①表格选择器统一改为「横向 chip 行 + 折叠搜索」（宽窄屏同一布局，替代 `<select>`）；②表头已有横向拖拽调列宽，新增纵向拖拽调**行高**（逐行，持久化）；③网格行区分**查看模式 / 编辑模式**（逐行，点击进编辑、失焦退出），已修改行背景色标记；④短文本/长文本/短文本列表统一 textarea 填满单元格；⑤多选（multi_select / multi_reference）改为原生 `<select multiple>`；⑥单元格默认尺寸：行高 ≈3 行文字（60px）、查看模式文本 3 行 / ~8 字截断省略号。保存模型保持**批量**（「保存」「放弃修改」按钮保留，编辑只在内存草稿），校验错误显示在**失败行的行底错误条**。

**Blocked by:** 无（11 已落地记录 CRUD，本票在其上改造）

**Status:** resolved

- [x] R1 表格选择器：横向 chip 行（scroll-snap、停用表置灰、选中高亮）+ 右侧折叠搜索（点击展开占满一行、chip 行让位、失焦/Esc 收起）；操作按钮（+新行/放弃修改/保存）在 chip 行上方独立一行；删除 `<select data-action="record-table-select">`
- [x] R2 行高：行号格下缘拖拽把手（复用列宽把手指针模式 + 键盘上下键 ±8px），逐行 min 40 / max 240 / 默认 60px；按 recordId 持久化（localStorage，新 key `ste-memory:grid-heights:<tableId>`）；行号列默认宽 40→48px
- [x] R3 查看模式：默认态整行格式化只读文本（`formDisplayValueText` + 引用字段经 referenceRecords 解析为目标记录 displayText、空值「未填写」占位、停用字段显示值）；文本 line-clamp 3 行 + 横向 ~8 字省略（所有类型统一截断）；显示的是**草稿值**（已修改行可见改动）
- [x] R3 编辑模式：点击行内单元格进入、焦点离开整行退出（行内 Tab/切字段不退出）；Esc = 撤销该行改动并退出（新行 = 删除草稿行）；可多条新行草稿并存（空草稿保存时跳过）
- [x] R3 脏行标记：已修改行（草稿 ≠ 原记录；新行填了值即脏——空草稿行不触发标记/保存/离开守卫）背景色微染；保存中行号格内容替换为转圈状态（平时无状态指示）
- [x] R3 保存：全校验 → 只提交通过校验的行 → 逐行提交（失败不阻断：成功行落库、失败行行底错误条 + 保留草稿，toast「已保存 N 条，失败 M 条」）；错误条逐字段「字段名：原因」（提交错误置顶），保留到下次保存或「放弃修改」；修订冲突保留草稿
- [x] R3 离开守卫：切 Tab / 关面板（含顶部按钮收起）/ 切表·翻页·搜索 时若有未保存修改 → 可取消的 Alert 确认（守卫注册在面板 Tab 切换/关闭处理器；`confirmDiscardIfDirty` 三入口照旧）
- [x] R3 详情联动：脏行点行号进详情照常，详情页头加「有未保存修改」小标记
- [x] R4 文本控件：short_text / long_text / short_text_list → textarea，固定填满单元格（内容超出内部滚动，不撑行）
- [x] R5 多选：multi_select / multi_reference → `<select multiple size=min(max(选项数,1),3)>`（桌面行内列表框适配默认行高；iOS 原生全屏选择器不动）；查看模式显示顿号拼接文本
- [x] 验收脚本：`verify-record-crud.mjs` 按新 DOM 重写（chip 行替换 select 选择器、查看/编辑模式、行底错误条、脏行标记、保存流程）；`verify-ui-shell.mjs` 记录 Tab 断言同步 + 顺带修复表格停用步骤的 DB/UI 读竞态
- [x] seam 测试：`grid-editor-model` 行高加载/持久化/clamp、单行脏判定、查看模式文本（引用解析）、行底错误条文案、逐行保存计划（带 rowKey）；`grid-editor.test.tsx` 冒烟随 DOM 更新；全仓 typecheck/prettier/eslint 绿
- [x] 真机验收：ST 实例中 verify-record-crud 19/19、verify-ui-shell 35/35（连续三轮全过，自清理）

## Answer

工作树提交（11 文件，st-extension seam/冒烟 210 例（ui 目录）+ 全仓 982/982 绿，typecheck 全仓绿，改动文件 eslint/prettier 绿；真机验收 verify-record-crud 19/19、verify-ui-shell 35/35）。

- **UI（`src/ui/record-view.tsx` + `grid-editor.tsx` + 三个 seam）**：chip 行选表（scroll-snap + 停用置灰 + 选中高亮，操作按钮独立一行）；折叠搜索（右侧图标 → 展开占满一行、chip 让位、失焦/Esc 收起）；查看/编辑模式逐行切换（查看模式格式化只读 + 引用解析 + 3 行/8 字截断，点击进编辑、失焦退、Esc 行级撤销、新行删除）；脏行背景色微染；保存中行号格转圈；行底错误条（提交错误置顶 + 逐字段校验文案，保留到下次保存/放弃修改）；批量保存逐行提交（失败不阻断 + 部分失败就地更新成功行保留失败草稿，避免 bumpData 丢草稿）；离开守卫（切 Tab/关面板/导航，可取消 confirm，与顶部按钮共享守卫槽）；详情页头「有未保存修改」标记；行高拖拽（行号格下缘把手 + 键盘 ±8，逐行持久化，行号列 48px）。
- **seam（`grid-editor-model.ts` +42 测试）**：`GridRowHeights`（默认 60/clamp 40-240/load-save localStorage 按 recordId 过滤）、`gridRowIsDirty`（单行脏判定，`hasUnsavedGridChanges` 改为其复用）、`gridDisplayValueText`/`buildReferenceLabelMap`（查看模式文本 + 引用解析）、`gridRowErrorLines`（错误条文案）、`GridSavePlan` 增 rowKey（逐行提交回填用）。
- **面板**：`panel-shell.tsx` 离开守卫接线（Tab/关闭按钮 + 顶部按钮共享 `leaveGuardRef`）；`st-panel-host.tsx` 双根共享守卫槽。
- **验收脚本**：`verify-record-crud.mjs` 重写记录流（chip 选表/错误条/查看-编辑/脏标记/搜索展开）；`verify-ui-shell.mjs` 记录 Tab 断言更新 + 表格停用步骤 DB/UI 竞态修复；两脚本补 `/* global */` 指令与无初值声明，lint 从 86 错归零。

## Comments

- 2026-08-15 code-review（双轴并行）结论：无 blocker。采纳：①保存只提交通过校验的行（修 toast 双重计数：校验失败行不进计划）；②行内失焦按整行判定（Tab/切字段不退出编辑）；③搜索展开占满一行（chip 让位）；④多选 size 下限 1；⑤顶部按钮收起面板也过离开守卫；⑥死 CSS 清理（stm-grid-readonly/-error/option-group 等）+ 守卫逻辑去重（gridHasUnsavedChanges）；⑦ticket 新行恒脏措辞修正为「填了值即脏」。未采纳（判断级）：行高把手 9px 触控目标与列宽把手一致（spec §11 触控 44px 针对 chip/开关类主交互，拖拽把手沿用既有先例）；record-view.tsx 继续膨胀（~900 行，God Component 阈值，拆 seam 记入后续票）。
- 真机验收：verify-record-crud.mjs 与 verify-ui-shell.mjs 连续三轮全过（19/19 + 35/35，自清理）。

## 决策记录（grill 会话定稿）

- 宽窄屏**统一**为 chip 行布局（用户拍板，无容器查询、无分栏）；chip 行 + 折叠搜索与操作按钮行，桌面/移动一致
- 保存模型：保持批量（用户推翻单行自动保存方案）；编辑仅内存草稿，点「保存」统一落库；「放弃修改」全局撤销
- 术语：**记录网格 / 查看模式 / 编辑模式**（已入 `apps/st-extension/CONTEXT.md`；「查看模式」避开与 core「显示策略」碰撞）
- 无 ADR：批量模型为现状，不满足 surprising 条件
- 不做：行级状态列、自动保存、行号格常驻状态点、自定义多选弹出层、容器查询分栏

## Comments

- 2026-08-15 grill-with-docs 会话定稿后落票。三轮问答：R1 布局（chip 行统一）、R2 逐行行高、R3 查看/编辑模式 + 批量保存 + 行底错误条 + 离开守卫、R4 textarea 填满、R5 原生多选、R6 默认尺寸与截断。
- 实现注意：`record-view.tsx` 已接近 God Component 阈值（ticket 11 记录在案）——本票新增 chip 行、守卫、行底错误条逻辑，若再膨胀考虑拆出 seam；`verify-record-crud.mjs` 的 `record-table-select` 选择器随本票移除。
