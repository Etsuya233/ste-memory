# 24 — 记录显示文本缺陷：批内引用渲染为空 + 详情页引用字段显示裸 ID

**Problem:** ST 插件 agent 用 `query_records` 查询 relationships 表时，`display` 显示为空，如 `" <-> "`（character_a/character_b 两个名字都没解析出来）；而网格里能看到名字，点进记录详情后关联字段（如「人物 A*」）却显示裸 UUID。该 bug 由真实使用场景报告（relations 7 条记录，revisionId 相同 = 同一批次提交）。

**涉及范围:** core（显示文本领域规则/提交/预览/query_records 工具）+ ST 插件（记录详情展示）。api 侧共享 core 修复，无需单独改动（见 Answer）。

**Blocked by:** （无）

**Status:** resolved

## Answer

### 根因

1. **空 display（写路径）**：填表 agent 一次 `submit_proposal` 批次里先 create 人物、再用 `tmp:` 临时 ID 引用它们 create 关系记录。提交时 `computeMemoryRecordDisplayText`（`core/src/memory/application/memory-record-display.ts`）用 `records.find()` 解析引用——同批新建尚未 commit 落库，解析不到 → 两个名字渲染为空串 → `" <-> "` 作为 **存储 displayText** 落库。`proposal_preview` 提前预览时同样渲染空。query_records 之前直接把这份可能过期的存储 displayText 丢给 agent → 存量记录永远显示空。
2. **详情页显示 ID（UI 路径）**：网格（`gridDisplayValueText`）读时把引用 id 解析成名字，但记录详情用 `recordFieldValueText`（`apps/st-extension/src/ui/record-form-model.ts`）直接打裸 id。

### 修复

**A. core 提交/预览路径批次感知（根因）**
- `memory-record-display.ts`：`computeMemoryRecordDisplayText` 新增可选 `resolveReference` 注入；抽出 `renderMemoryRecordDisplayTemplate`（模板渲染，字段视图 = id + referenceTableId）与 `createBatchReferenceResolver`（按 id + 目标表匹配批内待落库记录，惰性递归计算 + 缓存 + 引用环保护）。
- `memory-record-mutations.ts`：`MemoryRecordMutationContext.displayText` 第 4 参必传 resolver（编译期强制）；`commitMemoryRecordMutationBatch` 预计算批内 create（表/字段/解析后 payload），构建批次感知解析器，create 与 update 的 displayText 都经它解析。
- `memory-proposal-preview.ts`：`previewProposal` 注入同类解析器（按临时 ID），预览 display 立即正确。
- 宿主透传：`core/.../memory-record-service.ts`、`apps/api/src/main.ts`、`apps/st-extension/src/runtime.ts`（+ api 测试装配 `apps/api/test/test-application.ts`）。

**B. core query_records 读时解析显示文本（存量数据显示正确）**
- `query-records-tool.ts`：对模板策略表按当前字段定义与目标记录显示文本**读时重渲**（目标表按 `$record_id in` 批量取回、缓存；field 策略/无策略直接用存储值；解析失败回退存储 displayText，显示是辅助信息不阻断查询）。
- `agent/digest.ts`：digest 补 `displayStrategy`（MemoryTableDigest）与 `referenceTableId`（MemoryFieldDigest）——不进提示词，run 只建一次，维持「digest 只构建一次」测试；避免每次 execute 重复读表/字段。
- 工具描述补充说明 display 为读时计算。

**C. ST 插件详情引用字段解析**
- `record-form-model.ts` `recordFieldValueText` 支持标签映射（未知 id 回退原 id、空串引用渲染 —，与网格同语义）；`record-view.tsx` 把网格已有 `buildReferenceLabelMap` 传入 `RecordDetail`。

### 存量数据

已有 `" <-> "` 记录在 `query_records`/普通 UI 中读时解析即正确，无需手动改数据；存储 displayText 会在下次被更新时顺带纠正。注意到：HTTP 接口响应体里的 `displayText` 仍是存储快照（api 不读时重算），存量坏记录该字段需更新后才恢复。

### 验证

- 回归测试：`core/test/memory-record-batch-display.test.ts`（提交+预览批内引用，含链式 关系→人物→地点）、`core/test/agent/query-records-tool.test.ts` 新增读时显示 3 例（存量 `" <-> "`、field 策略零额外查询、目标缺失回退）、`record-form-model.test.ts` 详情引用解析。全部先证红（旧代码显示 `" <-> "`）后转绿。
- 全仓测试 127 文件 / 1183 例全绿；tsc / eslint / prettier 全过；插件 `dist/` 重新构建。

## Comments

- 2026-08-18 用户真实数据报告：query_records display 空、详情页引用字段显示 ID。
- 审查要点：错误优先级微调（批内 create payload 校验提前到 mutation 构建前，错误类型不变仍整批回滚）；tool 读时解析失败一律回退存储值。
