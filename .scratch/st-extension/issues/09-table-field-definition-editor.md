# 09 — 自定义表创建与字段定义编辑器

**What to build:** 手动创建自定义记忆表格（名称/描述/表格 Prompt/启停）与字段定义编辑器：12 种字段类型（类型创建后不可修改）、必填规则、固定选项、字段 Prompt、启停、显示顺序、引用字段目标（仅同一记忆空间内的指定表）；删除字段确认（显示策略依赖保护留待 10）；停用必填字段警告。

**Blocked by:** 03 — Dexie 持久层（一）；06 — 基础 UI 壳与设置面板

**Status:** resolved

- [x] 建表 + 字段编辑全流程可用，校验错误清晰可读
- [x] 字段类型创建后不可改；跨空间引用目标被拒绝
- [x] 停用必填字段给出警告；删除字段需确认
- [x] 刷新/重开对话后定义持久

## Answer

工作树提交（6 文件，+750 左右；新增 seam 测试 23 例，全仓 552/552 绿，typecheck/lint/build 全绿）。

- **纯逻辑 seam（`src/ui/table-editor-model.ts` / `field-editor-model.ts`）**：建表/字段草稿校验（空值、key 冲突即时提示）、选项文本解析（每行一个、trim、去空）、类型→配置形态映射（单选/多选需选项，单/多引用需目标表）、相邻字段 position 交换。均带 vitest 测试。
- **UI（`src/ui/table-editor.tsx` + `panel-shell.tsx`）**：表格列表顶部「新建表格」；自定义表卡片编辑（Key/名称/描述/Prompt）与删除（confirm，提示级联删字段与记录）；系统表只读标识；字段管理模式（上移/下移/编辑/删除 + confirm）；字段编辑器 12 类型下拉（编辑模式禁用类型选择 +「创建后不可修改」）、必填/启停开关（停用必填即时警告）、选项 textarea、引用目标表下拉（仅当前空间表）；`PanelRuntime` 端口补 create/delete。全部走 `--stm-*` 令牌，`data-action`/`data-stm-field` 只增不改。
- **复用而非重实现**：类型不可改、跨空间引用拒绝、停用必填警告、显示策略依赖删除保护全部由 core 服务强制（DomainError humanMsg 经 toastr 展示），UI 只做前置校验与接线。

## Comments

- 2026-08-09 code-review（双轴并行）结论：Standards 无硬违规遗留（审查发现 prettier 门禁 6 文件未格式化、`.stm-table-action` 触控目标 36px 低于 spec §11 的 ≥44px —— 均已修复：prettier --write 全量通过、min-height 改 44px）。判断级未采纳：表单动作行重复（规模小，提取收益低）；类型→配置映射与 core `memoryFieldConfiguration` 有意重复（core 为抛错式，seam 无法复用，注释记录演进风险）；验收脚本未同步新增 data-action（ticket 11 的 verify-record-crud 脚本将统一覆盖）。Spec 无 blocker；采纳两条修复：①删除字段 confirm 文案改为「记录中已填的旧值将保留但不再显示」（与实际语义一致：物理删字段定义，payload 旧值成孤儿）；②`saveFieldEdit` 在 update 返回 undefined（字段已消失）时不再静默关闭编辑器，改报错提示。
- 遗留与范围说明：US 19 显示策略配置 = ticket 10；US 15 系统表 Prompt/描述与字段 Prompt 查看入口未做（ticket 09 验收未列，如需可后续补）；删除表不检查他表 `referenceTableId` 悬空引用（core 行为，spec 未要求）；`docs/research/` 为 07/08 时期未跟踪调研文档，保持未提交。真机端到端验收未跑（ticket 09 无手动验收行）。
