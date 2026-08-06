# 17 — 填表任务覆盖视图（逐消息四态矩阵）

**Type:** task

**Status:** resolved

**Blocked by:** 13, 14

## Problem Statement

1000+ 条消息的会话里，用户无法知道哪些聊天记录已经填表跑过、哪些还没跑。现状只有两个聚合数字（`processedCount / totalCount`），`source_store_messages.status`（untracked / processed / error）没有查询出口，也没有「任务中待跑」这个派生概念。用户确认的显示方案：**整表一次查询，页面内渲染 50×N 颜色矩阵（每条消息一个单元格），颜色区分四态，hover 显示消息编号与状态**。

## Solution

新增覆盖视图：服务端把全部消息状态与活动任务范围合并分类为四态，一次返回；web 渲染 50 列网格矩阵 + 图例计数 + hover 提示。

**四态分类**（服务端派生，优先级从上到下）：

| 界面状态 | 判定 | 颜色 |
|---|---|---|
| 错误 | `status = error` | danger 红 |
| 已跑过 | `status = processed` | ok 绿 |
| 任务中待跑 | `status = untracked` 且 source_id ∈ 活动任务 `[from, to]` | accent 蓝 |
| 没计划 | 其余 `untracked` | 中性灰 |

## User Stories

1. 作为用户，打开填表任务面板，我想一屏看到整个会话每条消息的填表状态（哪个颜色区占了多大比例），以便判断覆盖情况。
2. 作为用户，hover 任意单元格，我想看到该消息的编号（source_id）与状态名，以便知道这块格子对应聊天里的哪条消息。
3. 作为用户，任务运行中，我想看到矩阵实时推进（待跑变已跑），以便确认进度。
4. 作为用户，任务终态后矩阵自动收敛，错误块保持红色可辨认。

## Structural Map

```
apps/api/src
├── application/ports/source-chat.ts            # + SourceMessageStatus + messageStatuses()
├── application/ports/fill-task.ts              # + MessageFillState / FillTaskCoverageView
├── application/ports/fill-task-manager.ts      # + coverage(memorySpaceId)
├── application/fill-tasks/fill-task-service.ts # + coverage()：空间校验 + 组合查询（委托分类模块）
├── application/fill-tasks/fill-task-coverage.ts # 新增：classifyMessages 纯分类（四态优先级）
├── adapters/outbound/sqlite/source-store/repository.ts  # + messageStatuses（source_id 升序）
└── adapters/inbound/http/fill-tasks/routes.ts  # + GET /memory-spaces/:spaceId/fill-tasks/coverage（404）
apps/web/src
├── api/fill-tasks.ts                           # + MessageFillState / FillTaskCoverage / fetchFillTaskCoverage
├── fill-task-coverage-state.ts                 # 新增：summarizeCoverage 纯函数（计数，命名与服务端一致）
├── components/FillTaskCoverageMatrix.tsx       # 新增：图例 + 50 列矩阵 + hover 提示（列数常量驱动）
├── components/FillTaskSubmitForm.tsx           # 新增：自 FillTaskPanel 拆出提交表单（300 行规则）
├── components/FillTaskLogView.tsx              # 新增：自 FillTaskPanel 拆出日志视图（300 行规则）
├── components/FillTaskPanel.tsx                # 改：coverage 状态 + 轮询（复用活动任务节奏）+ 渲染矩阵
├── fill-task-panel-state.ts                    # 改：STATUS_META 上移至此（面板与日志视图共用）
├── memory-table-workspace.css                  # 改：+ 矩阵/图例/hover 样式
└── fill-task-coverage-state.test.ts            # 新增：计数纯函数测试
```

依赖方向不变：web → HTTP；HTTP → 应用端口；`FillTaskService` 组合 `SourceChatRepository` 与 `FillTaskRepository`。禁止绕过：coverage 端点只读，不触碰任务行状态；分类必须服务端做（活动任务范围是服务端事实）。

## Acceptance Criteria

1. `GET /memory-spaces/:spaceId/fill-tasks/coverage` 返回全部消息的 `{ sourceId, state }`（source_id 升序）；四态计数之和 = 消息总数。
2. 无活动任务时「任务中待跑」恒为 0；活动任务范围内 untracked 全部为「任务中待跑」，范围外为「没计划」。
3. `error` 消息无论是否在活动任务范围内都分类为「错误」；`processed` 保持「已跑过」。
4. 空间不存在 → 404（与既有 fill-task 端点一致）。
5. 填表任务面板显示图例（四色 + 计数）+ 50 列矩阵；hover 单元格显示消息编号与状态名；任务运行中随轮询（2s）实时推进，终态后自动收敛。
6. 新增测试：api 覆盖四态分类矩阵（无任务 / 挂起任务范围内外 / 失败后 error / 全部 processed / 404）；web 覆盖计数纯函数。全仓 typecheck / lint / prettier / test 干净。
7. FillTaskPanel.tsx 拆出日志视图后不超过 300 行（仓库规则），行为不变。

## Implementation Decisions

- **覆盖响应只含 states**：`{ states: [{ sourceId, state }] }`，不含 activeTask（面板已轮询活动任务，避免重复事实源）；计数由前端从 states 推导（单一事实源）。
- **矩阵列数固定 50**（用户确认）：`grid-template-columns: repeat(50, minmax(6px, 1fr))`，1000 条 = 20 行，一屏放下。
- **hover 用 CSS 实现**：单元格 `:hover` 显示绝对定位小卡片（消息 #source_id + 状态名），无 JS 状态、1000 单元格零开销。
- **轮询复用活动任务节奏**：`useEffect([space.id, active !== null])`——有活动任务时每 2s 刷新 coverage；任务终态/提交任务时立即刷新一次。
- **hover 内容 v1 不含说话人/内容**：coverage 只传 source_id + state，不复制消息内容（与 messages 端点职责分离）；后续需要时给矩阵加可选 messages prop。

## Out of Scope

- 矩阵单元格点击跳转原始聊天（跨组件联动，后续）。
- 说话人/内容预览的 hover（同上，需要消息数据下传）。
- 任务历史列表（终态任务展示归 15）。

## Assumptions and Open Questions

- 「聊天编号和 ID」解释为 source_id（本系统消息的唯一稳定标识）与状态名；如需说话人/内容预览后续扩展。
- 无关键开放问题。

## Code Review（2026-08 双轴评审后处置）

- 矩阵列宽按票内决策对齐 `minmax(6px, 1fr)`；补「全部 processed」测试场景（AC6 五场景齐）。
- 计数键与服务端统一为 `in_task`，删除 COUNT_KEYS 桥接映射；STATUS_META 上移至
  `fill-task-panel-state.ts`（面板与日志视图共用，消除 LogView 模块承载非日志元数据的内聚问题）。
- `fill-task-service.ts` 中的分类逻辑抽至 `fill-task-coverage.ts`（纯函数，避免循环依赖），
  该文件净增控制在 +20 行以内；**既有债务**：该文件此前已 499 行（ticket 13/14/16 累积），
  超 300 行规则属既有违约，完整按职责拆分需独立重构票，不并入本票。
- 全仓 prettier 有 23 个既有文件告警（ui.tsx / theme.css / seed 脚本 / pi-session HTML 等），
  均非本票触碰文件；本票全部文件 prettier 干净。

## Answer

已实现并提交（ticket 17）。

**api**：`SourceChatRepository.messageStatuses`（全部消息 source_id 升序）；`FillTaskService.coverage`
（空间校验 + 活动任务范围 + 四态分类，分类纯逻辑在 `fill-task-coverage.ts`）；新端点
`GET /memory-spaces/:spaceId/fill-tasks/coverage`（空间不存在 404）。分类优先级：
error > processed > 活动任务范围内 untracked（in_task）> unplanned。

**web**：`FillTaskCoverageMatrix`（50 列网格、四色图例计数、CSS hover 提示消息编号与状态名）；
`fill-task-coverage-state.ts` 计数纯函数；面板按活动任务节奏轮询（2s），提交/终态即时刷新；
`FillTaskPanel` 按 300 行规则拆出日志视图与提交表单（300 行达标）。

**测试**：api 6 例（无任务全 unplanned / 挂起任务范围内外 / 失败块 error / 成功全 processed /
四态混合优先级 / 404）；web 计数与图例单测。全仓 246 测试通过，typecheck/lint 干净，
本票全部文件 prettier 干净。
