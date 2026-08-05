# 01 — 清洗规则 API：迁移、变换逻辑与端点

**Type:** task

**Status:** resolved

**What to build:** 清洗规则的持久化（`cleaning_rules` 表 + 迁移）、纯变换函数、应用层服务与 HTTP CRUD/排序端点，并在消息展示与填表任务两条读取路径套用变换。

- [x] 迁移 0005：`cleaning_rules` 表（memory_space_id、position、enabled、name、mode、pattern、flags、created_at、updated_at），含回滚。
- [x] 纯变换函数 `applyCleaningRules(content, rules)`：按 position 顺序只对启用规则执行；保留 = 捕获组 1（若有）否则整段匹配的全局拼接，无匹配原样不动；去掉 = 删除所有匹配；空匹配正则允许（JS 引擎自动推进 lastIndex）。
- [x] 应用层服务：规则 CRUD（创建追加到末尾、更新、删除、整列表重排）与校验（正则语法错误 → 400，pattern/flags 必填，flags 仅限 gimsu y）。
- [x] HTTP 端点：GET/POST /memory-spaces/:id/cleaning-rules、PATCH/DELETE /memory-spaces/:id/cleaning-rules/:ruleId、PUT /memory-spaces/:id/cleaning-rules/order。
- [x] 展示路径：GET /memory-spaces/:id/messages 返回清洗后内容（原文不动）。
- [x] 填表路径：fill-task 块处理在 composeBlockPrompt 前套用变换。
- [x] 测试：变换纯函数（保留/去掉/捕获组/无匹配/顺序/停用/空匹配正则）、校验、端点、展示与填表集成。

## Answer

已实现（2026-08-06）：
- 迁移 0005 `cleaning_rules` 表；KyselyCleaningRuleRepository（create 追加末尾 / update 合并校验 / delete 后重排连续 / reorder 校验集合）。
- 纯变换 `applyCleaningRules`（保留=捕获组1否则整段匹配的全局拼接，无匹配 no-op；去掉=删匹配；空匹配正则放行）。
- 5 个 HTTP 端点 + 校验（语法错误/非法 flags 400）；`GET /messages` 支持 `raw=1` 与 `limit`。
- 展示路径（DefaultMemorySpaceManager.messages）与填表路径（FillTaskService.#processBlock）套用变换，原文存储不变（ADR apps/0001）。
- 测试：`apps/api/test/cleaning-rules.test.ts` 16 例；全套 194 例通过。

## 评审修正（code review 2026-08-06）

- 创建接受 `enabled`（默认 true）：草稿里关掉的新规则保存后不再被硬编码为启用。
- 重排 id 集合不匹配改 400（原 404，语义错误）。
- `raw=1` 时跳过规则查询；manager 补模块注释。
- 测试按关注点拆三个文件（transform / API / fill-task 集成，均 < 300 行），全套 196 例通过。
