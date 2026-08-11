import { describe, expect, it } from "vitest";
import type { FillTaskView, FloorLedgerEntry } from "../fill-tasks/fill-task.ts";
import {
  buildTasksTabViewModel,
  taskStatusViewModel,
  unprocessedRanges,
  validateFloorRange,
  type TasksTabViewModel,
} from "./task-panel-model.ts";
import type { MemorySpaceId } from "@ste-memory/core/memory";

const SPACE = "space-1" as MemorySpaceId;

function task(overrides: Partial<FillTaskView> = {}): FillTaskView {
  return {
    runId: "run-1",
    memorySpaceId: SPACE,
    from: 0,
    to: 9,
    blockSize: 20,
    chatId: null,
    status: "running",
    errorMessage: null,
    createdAt: "2026-07-30T01:02:03.000Z",
    updatedAt: "2026-07-30T01:02:03.000Z",
    processedCount: 4,
    totalCount: 10,
    ...overrides,
  };
}

function entries(
  ...pairs: readonly [floor: number, status: "processed" | "error"][]
): FloorLedgerEntry[] {
  return pairs.map(([floor, status]) => ({ floor, status }));
}

describe("unprocessedRanges（未处理范围：台账 untracked = 无行）", () => {
  it("从台账 + 对话长度推出连续未处理区间（闭区间楼层）", () => {
    const ledger = entries([0, "processed"], [1, "error"], [2, "processed"], [5, "processed"]);
    expect(unprocessedRanges(ledger, 8)).toEqual([
      { from: 3, to: 4 },
      { from: 6, to: 7 },
    ]);
  });

  it("全部已处理 → 空；全部未处理 → 整段", () => {
    expect(unprocessedRanges(entries([0, "processed"], [1, "processed"]), 4)).toEqual([
      { from: 2, to: 3 },
    ]);
    expect(unprocessedRanges([], 5)).toEqual([{ from: 0, to: 4 }]);
    expect(unprocessedRanges([], 0)).toEqual([]);
  });
});

describe("validateFloorRange（楼层输入校验：同步楼层 0 基）", () => {
  it("合法闭区间 → ok（含边界 0 与 chatLength-1）", () => {
    expect(validateFloorRange("2", "5", 8)).toEqual({ kind: "ok", from: 2, to: 5 });
    expect(validateFloorRange("0", "7", 8)).toEqual({ kind: "ok", from: 0, to: 7 });
    expect(validateFloorRange("", "", 8)).toEqual({
      kind: "ok",
      from: 0,
      to: 7,
    });
  });

  it("非法输入 → error 且原因可读", () => {
    expect(validateFloorRange("abc", "5", 8).kind).toBe("error");
    expect(validateFloorRange("2", "x", 8).kind).toBe("error");
    expect(validateFloorRange("5", "2", 8)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("不能大于"),
    });
    expect(validateFloorRange("-1", "5", 8)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("0"),
    });
    expect(validateFloorRange("2", "8", 8)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("共 8 条"),
    });
    expect(validateFloorRange("2", "5", 0)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("没有消息"),
    });
  });
});

describe("taskStatusViewModel（任务状态 → 文案，失败原因可读）", () => {
  it("running：状态 + 进度；succeeded/failed/interrupted：终态文案，failed 带错误信息", () => {
    expect(taskStatusViewModel(task())).toEqual({ label: "运行中", detail: "已处理 4/10 层" });
    expect(taskStatusViewModel(task({ status: "succeeded" }))).toEqual({
      label: "已完成",
      detail: "",
    });
    expect(
      taskStatusViewModel(task({ status: "failed", errorMessage: "Agent 运行失败：模型炸了" })),
    ).toEqual({ label: "失败", detail: "Agent 运行失败：模型炸了" });
    expect(taskStatusViewModel(task({ status: "interrupted" }))).toEqual({
      label: "已中断",
      detail: "",
    });
  });
});

describe("buildTasksTabViewModel（任务 Tab 视图模型：触发表单 + 活动任务 + 最近结果）", () => {
  const base = {
    chatLength: 8,
    ledger: entries([0, "processed"], [5, "error"]),
    activeTask: undefined as FillTaskView | undefined,
    recentTask: undefined as FillTaskView | undefined,
  };

  it("无活动任务：可触发，表单预填首个未处理范围，最近结果展示失败原因", () => {
    const view: TasksTabViewModel = buildTasksTabViewModel({
      ...base,
      recentTask: task({
        status: "failed",
        errorMessage: "消息块 [0, 19] 内没有可处理的消息",
        from: 0,
        to: 3,
        processedCount: 0,
        totalCount: 4,
      }),
    });
    expect(view).toMatchObject({
      canTrigger: true,
      hasActiveTask: false,
      unprocessedHint: "未处理楼层 1–4 · 共 6 层",
      defaultFrom: "1",
      defaultTo: "4",
      lastResult: { label: "失败", detail: "消息块 [0, 19] 内没有可处理的消息" },
    });
  });

  it("有活动任务：不可触发，展示运行中状态与范围", () => {
    const view = buildTasksTabViewModel({
      ...base,
      activeTask: task({ from: 2, to: 7, processedCount: 3, totalCount: 6 }),
    });
    expect(view).toMatchObject({
      canTrigger: false,
      hasActiveTask: true,
      activeTaskRunId: "run-1",
      activeTaskLabel: "运行中",
      activeTaskDetail: "已处理 3/6 层",
      activeRange: "楼层 2–7",
    });
  });

  it("最近结果不重复展示运行中的任务（recentTask 与活动任务同 runId 时置空）", () => {
    const view = buildTasksTabViewModel({
      ...base,
      activeTask: task({ from: 2, to: 7 }),
      recentTask: task({ from: 2, to: 7 }), // 同一任务
    });
    expect(view.hasActiveTask).toBe(true);
    expect(view.lastResult).toBeNull();
  });

  it("全部楼层已处理：无未处理提示，表单留空", () => {
    const view = buildTasksTabViewModel({
      ...base,
      ledger: entries([0, "processed"], [1, "processed"], [2, "processed"]),
      chatLength: 3,
    });
    expect(view).toMatchObject({
      canTrigger: true,
      unprocessedHint: null,
      defaultFrom: "",
      defaultTo: "",
    });
  });

  it("空对话：不可触发，提示没有消息", () => {
    const view = buildTasksTabViewModel({ ...base, chatLength: 0 });
    expect(view).toMatchObject({
      canTrigger: false,
      unprocessedHint: null,
      defaultFrom: "",
      defaultTo: "",
    });
    expect(view.noMessages).toBe(true);
  });

  it("最近任务非终态视图不存在时不展示（recentTask 为 undefined）", () => {
    const view = buildTasksTabViewModel(base);
    expect(view.lastResult).toBeNull();
  });
});
