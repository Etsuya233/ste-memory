# 11 — 记录视图与手动增删改

**What to build:** 记录列表（按表查看、搜索、分页、显示文本）；记录详情（字段值与字段证据）；手动创建/编辑/删除记忆记录（字段校验：必填、选项、日期、数值、引用目标）；手动记录与 Agent 修订的来源区分；停用字段的值保留可查看；证据楼层 chip（签名元素：铜绿 + 等宽楼层号，点按跳转 ST 对应消息，悬停/长按浮出原文摘录）。

**Blocked by:** 04 — Dexie 持久层（二）；05 — 空间绑定与消息同步；06 — 基础 UI 壳与设置面板

**Status:** resolved

- [x] 记录 CRUD 全流程 + 字段校验错误清晰
- [x] 手动记录与 Agent 修订在详情中可区分；停用字段值可见
- [x] 证据楼层 chip 跳转 ST 对应消息；无证据的手动记录明确标注
- [x] 手动验收：真实 ST 中创建/编辑/删除记录并跳转验证

## Answer

工作树提交（20 文件，+2300 左右；st-extension seam/冒烟 42 例 + core 漂移修复 5 例，全仓 623/623 绿，typecheck/prettier/eslint 全绿）。真机验收独立复跑：verify-record-crud.mjs 17/17、verify-ui-shell.mjs 29/29（均自清理）。

- **UI（`src/ui/record-view.tsx` + 三个 seam）**：记录 tab = 表选择器 + 搜索 + 分页（10/页）+ 列表行（显示文本**读时计算**（core `previewDisplayText`，降级存储 displayText）+ 来源徽标）；详情 = 全字段值（含停用字段 + 「已停用」徽标，值保留可见）、逐字段证据 chip、来源徽标（手动/Agent）+ 修订摘要行（listHistory 最新 revisionSource + 时间 + 修订总数）、「无证据（手动记录）」标注（来源徽标与标注联动，Agent 证据被清空时只显示「无证据」）；创建/编辑表单逐类型输入 + 逐字段中文前置校验（必填/选项/日期/数值/引用目标），编辑补丁只带变化字段（保护 Agent 记录未动字段的证据）；datetime 比较归一化到分钟精度（草稿截秒不回写，存量秒级值不被无关编辑清掉，带 3 例 seam 测试）。
- **证据楼层 chip（签名元素）**：铜绿（`--stm-accent`）+ 等宽 `#N`；点按 `scrollToFloor`（out-of-range/not-loaded → 中文 warning）；悬停/长按（pointer 500ms）浮出原文摘录（楼层 + 发送者 + 截断 120 字符）；`sync_floor` 常量 = ST 同步楼层证据 source_type（ADR 0003），未知 source_type 渲染中性徽标；真机验证点按跳转高亮（stm-floor-flash）。
- **adapter**：StChatAdapter 新增 `getMessageAt(floor)`（ST mes 形状映射，薄层）；PanelRuntime 端口加 `records` 服务子集 + `st`（scrollToFloor/getMessageAt）。
- **core 读路径修复（协调者决策，跨票缺陷）**：core 读路径原对存储 payload 严格校验——删除字段（孤儿键）、新增必填（旧记录缺值）、选项变更（旧值出选项）、目标表删除（悬空引用）任一发生都会让整表记录不可读（ticket 09 删字段即触发）。修复：`projectStoredMemoryRecordPayload` 读路径宽松投影（只做类型级校验，类型不可变保证类型损坏=外部篡改仍拒绝；漂移一律容忍）+ `validateMemoryRecordPatch` 写路径 patch 逐键严格校验 + 宽松合并；引用最终校验只针对 patch 写入的键（拖尾引用不阻断无关编辑，目标表已删时抛 DomainError 而非 TypeError）。写路径严格性不变（未知键/清空必填仍拒绝，测试实证）。测试基建顺带补全：Records fake 实现真实 commit。

## Comments

- 2026-08-09 code-review（双轴并行）结论：无 blocker。采纳五条修复：①`.stm-evidence-chip` 触控高度 36px→44px（签名元素，spec §11）；②datetime 草稿截秒往返——未编辑的秒级差异不再进 patch，存量记录不被无关编辑清秒（+3 seam 测试）；③「无证据」标注与来源徽标联动（Agent 来源证据被清空时不再误标「手动记录」）；④mutations 引用查找对已删目标表返回 undefined（抛 DomainError 而非裸 TypeError）；⑤组件内 formValueText 去重移入 seam（formDisplayValueText）。未采纳（判断级）：列表搜索用存储 displayText 而渲染用读时计算——core list 搜索同时覆盖 payload 值，影响低，记录在案；record-view.tsx 966 行接近 God Component 阈值（交互密集的 tab 视图，暂无拆分收益）。
- 遗留：编辑 Agent 记录会清掉被改字段的证据（core update 按 patch 键合并证据的既有语义，接受）；引用字段选项标签用目标记录存储 displayText（策略变更后可能过期，读时计算待后续票）；真机脚本种子的证据记录在验收后清理。
- 真机验收：verify-record-crud.mjs 与 verify-ui-shell.mjs 均独立复跑全过（ST 1.18.0 本地实例，测试角色 Seraphina）。
