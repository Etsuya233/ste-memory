# 25 — 手动标记楼层进度

**What to build:** 在任务面板中新增「标记楼层进度」折叠区域，允许用户对指定楼层区间 `[from, to]` 批量设置台账状态（processed / untracked / error），用于导入对话后跳过已知楼层、撤销误处理、或手动标记问题楼层。操作完成后通过 `ste-memory:ledger-changed` 事件通知各视图刷新。

**Blocked by:** 13 — 填表任务（台账端口已交付）

**Status:** ready-for-agent

> **注意**：本 spec 中引用的代码片段仅供理解设计意图，不约束具体实现。实现者应以 spec 的语义描述和接口签名为准，自行决定代码结构。

## Problem Statement

导入对话后，当前对话的填表进度为空（全部 untracked），用户无法跳过前面已知不需要处理的楼层，只能等 Agent 逐块处理完。此外，用户审查已处理记录后可能发现某段填写有误，想手动标 error 提醒后续重跑；或误操作标记了 processed 想撤销。目前没有任何手动编辑台账的入口。

## Solution

在任务面板（Tasks Tab）的触发区与活动任务区之间，新增折叠区域「标记楼层进度」：目标状态下拉（processed / untracked / error）+ from/to 输入框 + 执行按钮。操作前显示确认摘要，操作后通过事件刷新覆盖视图与未处理范围提示。运行中任务时禁用操作。

## User Stories

1. As a user who imported a conversation, I want to mark the first N floors as processed, so that the fill task skips them and starts from where new content begins.
2. As a user who imported a conversation, I want to mark a specific floor range as processed, so that I can skip floors that don't need agent processing.
3. As a user who reviewed agent-filled records, I want to mark a floor range as error, so that I can flag those floors as needing reprocessing.
4. As a user who marked floors as processed by mistake, I want to mark them back as untracked, so that the next fill task will process them again.
5. As a user who marked floors as error manually, I want to mark them as processed, so that I can skip them after deciding they're actually fine.
6. As a user, I want to see a confirmation summary before the mark operation executes, so that I don't accidentally change floor statuses.
7. As a user, I want the floor range inputs to be validated with readable error messages, so that I don't submit invalid ranges.
8. As a user, I want the default floor range to be pre-filled with the first unprocessed range, so that I can quickly mark common ranges.
9. As a user, I want the mark operation to be disabled when a fill task is running, so that I don't create confusing state by modifying the ledger mid-task.
10. As a user, I want the coverage strip and unprocessed hint to update immediately after marking, so that I can verify the operation took effect.
11. As a user, I want to mark floors as untracked (deleting ledger rows), so that I can undo a previous processed/error mark.
12. As a user, I want to mark floors as error without providing a reason text, so that the operation is quick and simple.
13. As a user, I want the mark operation to accept floor ranges where some floors don't have messages (drift-accepted), so that I'm not blocked by message deletion/gap.
14. As a user, I want the mark operation to work on error-status floors (overwriting to processed), so that I can skip floors that were previously marked as failed.
15. As a user, I want the mark operation to work on processed-status floors (overwriting to untracked or error), so that I can change my mind about previously marked floors.
16. As a user, I want the foldable section to have a clear title "标记楼层进度", so that I can find it easily in the task panel.
17. As a user, I want the target status dropdown to show all three options clearly (processed = 已处理, untracked = 未处理, error = 出错), so that I understand what each option means.
18. As a user, I want the confirmation message to show the exact range and target status (e.g., "将把楼层 0–19 标记为已处理，共 20 层"), so that I can verify before confirming.
19. As a user, I want validation errors to appear inline below the form, so that I can fix them without losing my input.
20. As a user, I want the operation to be atomic (all floors in the range are marked together), so that I don't end up with partial state.

## Implementation Decisions

### 1. Service layer: `markFloorStatuses` method on `FillTaskService`

Add a new public method to `FillTaskService`:

```typescript
async markFloorStatuses(
  memorySpaceId: MemorySpaceId,
  from: number,
  to: number,
  status: "processed" | "untracked" | "error",
): Promise<void>
```

Behavior:
- **Guard**: check active task via `this.#tasks.findActive(memorySpaceId)` — if non-terminal task exists, throw `FillTaskConflictError` (reuse existing error class).
- **Validation**: reuse `validateFloorRange` logic from `task-panel-model.ts` (from/to integers, bounds, from <= to). Throw `FillTaskRangeError` on failure.
- **Status dispatch**:
  - `"processed"` → `this.#ledger.markProcessed(memorySpaceId, floors)` (existing port method, floors = array from `from` to `to` inclusive).
  - `"error"` → `this.#ledger.markError(memorySpaceId, floors)` (existing port method).
  - `"untracked"` → delete ledger rows for the range. This requires a new port method on `FloorLedgerRepository`:

### 2. New port method: `FloorLedgerRepository.deleteStatuses`

```typescript
deleteStatuses(memorySpaceId: MemorySpaceId, from: number, to: number): Promise<void>;
```

Implementation in `DexieFloorLedgerRepository`: delete all rows in `[memorySpaceId+floor]` range (same query pattern as `statuses()` but `.delete()` instead of `.toArray()`). Floors with no row are already untracked — deleting non-existent rows is a no-op.

### 3. Validation reuse

The `validateFloorRange` function in `task-panel-model.ts` currently takes `(fromText, toText, chatLength)` and returns a discriminated union. The service layer needs integer validation, not string parsing. Two options:

- **(A)** Extract an integer-only `validateFloorRangeIntegers(from, to, chatLength)` from the existing function and call it from both the service and the string-parsing wrapper.
- **(B)** Have the service call `validateFloorRange(String(from), String(to), chatLength)` — semantically wrong but functionally correct.

Recommend **(A)**: extract the core integer validation as a pure function `validateFloorRangeIntegers` (or rename existing to `validateFloorRangeText` and add `validateFloorRange`). The service uses the integer version; the UI string-parsing wrapper delegates to it.

### 4. Floor array generation

For `markProcessed`/`markError`/`deleteStatuses`, the service needs to generate `floors: number[]` from `from` to `to`. Simple `Array.from({ length: to - from + 1 }, (_, i) => from + i)`. The `deleteStatuses` port takes `(from, to)` directly (range-based delete, no array needed).

### 5. Event: `ste-memory:ledger-changed`

After successful mark operation, dispatch a custom DOM event:

```typescript
document.dispatchEvent(new CustomEvent("ste-memory:ledger-changed", {
  detail: { memorySpaceId, from, to, status },
}));
```

The `TasksTab` component subscribes via `useEffect` and increments `reloadKey` to re-fetch ledger data and rebuild the view model. This avoids introducing a general event bus — one event, one subscriber pattern.

Subscription in `TasksTab`:

```typescript
useEffect(() => {
  const handler = () => setReloadKey((k) => k + 1);
  document.addEventListener("ste-memory:ledger-changed", handler);
  return () => document.removeEventListener("ste-memory:ledger-changed", handler);
}, []);
```

### 6. UI: foldable section in TasksTab

Location in `tasks-tab.tsx`: between the trigger section (`data-stm-section="trigger"`) and the active task section (`data-stm-section="active-task"`). Collapsed by default.

Elements:
- `data-stm-section="mark-ledger"` — foldable container
- Title: "标记楼层进度"
- Target status: `<select data-stm-field="mark-status">` with three `<option>` values: `processed` (已处理), `untracked` (未处理), `error` (出错)
- Floor range: two `<input type="text" inputMode="numeric">` fields (from/to), same pattern as trigger form
- Execute button: `<button data-action="mark-floor-statuses">`, disabled when `hasActiveTask` is true
- Confirmation: before executing, show `window.confirm()` with summary text (e.g., "将把楼层 0–19 标记为已处理，共 20 层")
- Validation error: inline `<div data-stm-field="mark-error">` below the form
- Success feedback: `reportSuccess()` (same as trigger/cancel)

### 7. Default values for mark form

Pre-fill from/to with the first unprocessed range (reuse `unprocessedRanges` from `task-panel-model.ts`). Same logic as trigger form default values.

### 8. Runtime interface extension

Add `markFloorStatuses` to `TasksTabRuntime`:

```typescript
readonly tasks: Pick<FillTaskService, /* existing methods */ | "markFloorStatuses">;
```

### 9. No schema changes

The `floorFillLedger` Dexie table schema (`&[memorySpaceId+floor]`) already supports all operations. `deleteStatuses` uses range-delete on the existing compound index.

## Testing Decisions

### What makes a good test
- Test the service method `markFloorStatuses` against the `FloorLedgerRepository` port (mock or in-memory), verifying:
  - Correct port method called for each status
  - Range validation enforcement (out-of-bounds, from > to)
  - Active task guard (throws when task is running)
  - Edge cases: empty range (from == to), full range (0 to chatLength-1), floors with no messages
- Test `deleteStatuses` in `DexieFloorLedgerRepository` (real Dexie): verify rows are deleted, non-existent floors are no-op, other floors are untouched
- Test `validateFloorRangeIntegers` pure function: boundary conditions
- Test the UI model: `buildTasksTabViewModel` with ledger changes reflected in `unprocessedHint` and `coverage`
- Integration: mark → verify coverage strip updates via `ste-memory:ledger-changed` event

### Modules to test
- `fill-task-service.ts` — `markFloorStatuses` method (new)
- `fill-task-repository.ts` — `DexieFloorLedgerRepository.deleteStatuses` (new)
- `task-panel-model.ts` — `validateFloorRangeIntegers` (extracted), `buildTasksTabViewModel` with modified ledger
- `task-panel-model.test.ts` — extend existing tests

### Prior art
- Existing `submit` test pattern in `fill-task-service.test.ts`: mock ports, verify guard + delegation
- Existing `DexieFloorLedgerRepository` tests in `fill-task-repository.test.ts`: real Dexie, verify row CRUD
- Existing `task-panel-model.test.ts`: pure function tests for view model building

## Out of Scope

- Undo/history for manual mark operations (operations are reversible by marking again)
- Auto-integration with conversation import flow
- Per-floor (non-interval) selection UI
- Reason text for manual error marks
- Event bus beyond the single `ste-memory:ledger-changed` event
- Changes to "清除空间记录" or "重置空间" behavior (already clears ledger)

## Further Notes

- The `FloorLedgerRepository` port gains one method (`deleteStatuses`). This is the only port change.
- The `FillTaskService` gains one public method (`markFloorStatuses`). No changes to the task state machine or block processing loop.
- The `task-panel-model.ts` gains one extracted pure function (`validateFloorRangeIntegers`). The existing `validateFloorRange` delegates to it.
- CSS classes follow existing `stm-*` naming convention.
- `data-stm-*` / `data-action-*` attributes follow existing acceptance test contract.
