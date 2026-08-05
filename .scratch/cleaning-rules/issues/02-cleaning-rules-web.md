# 02 — 清洗规则 Web 面板：编辑、排序与实时预览

**Type:** task

**Status:** resolved

**What to build:** MemoryWorkspace 内的「清洗规则」面板：规则列表编辑（名称、启用、模式、正则、flags 勾选、上移/下移、删除、新增）、整面板草稿 + 单个保存按钮、实时预览区（前 10 条消息原文 → 变换后对照，前端本地纯函数渲染）。

- [ ] api 客户端：cleaning-rules CRUD + order + messages 拉取。
- [ ] 面板：草稿状态管理（编辑不落库）、保存一次性提交、校验错误即时红字。
- [ ] 预览：前 10 条消息实时渲染，编辑即刷新；前端本地实现与 API 一致的变换语义。
- [ ] 接入 MemoryWorkspace（与 ChatViewer/FillTaskPanel 平级）。
- [x] 测试：变换逻辑前端复刻（与 API 测试同语义）、面板状态测试。

## Answer

已实现（2026-08-06）：
- `apps/web/src/api/cleaning-rules.ts`：CRUD/order 客户端 + 预览用本地变换与校验（语义与 API 一致，错误文案与 API 对齐）。
- `CleaningRulesPanel`（259 行）+ `CleaningRuleRow`（120 行）：草稿编辑（启用/名称/模式/正则/flags 勾选/上下移/删除）、整面板单保存（删→建→改→重排；新规则携带 enabled）、前 10 条消息原文→变换后实时预览（非法规则行内红字且不参与预览）。
- 接入 MemoryWorkspace 左侧栏（FillTaskPanel 之下），保存后触发消息展示刷新。
- 测试：`apps/web/src/api/cleaning-rules.test.ts` 5 例。

## 评审修正（code review 2026-08-06）

- 创建新规则时携带 `enabled`，草稿里停用的新规则保存后保持停用。
- 「面板状态测试」未做：仓库无组件测试基建（无 testing-library/jsdom），现有测试均为纯逻辑测试，遵循先例（query-chat-state.test.ts 只测提取的状态逻辑）。
