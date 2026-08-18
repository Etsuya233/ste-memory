import { describe, expect, it } from "vitest";
import type { FillTaskView, FloorLedgerEntry } from "../fill-tasks/fill-task.ts";
import {
  buildCoverageViewModel,
  buildTasksTabViewModel,
  taskStatusViewModel,
  unprocessedRanges,
  validateBlockSize,
  validateFloorRange,
  type CoverageViewModel,
  type TasksTabViewModel,
} from "./task-panel-model.ts";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { CleaningRuleList } from "../settings/cleaning-rule-lists.ts";

const SPACE = "space-1" as MemorySpaceId;

function task(overrides: Partial<FillTaskView> = {}): FillTaskView {
  return {
    runId: "run-1",
    memorySpaceId: SPACE,
    from: 0,
    to: 9,
    blockSize: 20,
    kind: "floor",
    initText: null,
    chatId: null,
    status: "running",
    errorMessage: null,
    createdAt: "2026-07-30T01:02:03.000Z",
    updatedAt: "2026-07-30T01:02:03.000Z",
    processedCount: 4,
    totalCount: 10,
    // 测试数据构造：overrides 可覆盖 kind/initText（联合成员由调用方保证一致）
    ...overrides,
  } as FillTaskView;
}

function entries(
  ...pairs: readonly [floor: number, status: "processed" | "error"][]
): FloorLedgerEntry[] {
  return pairs.map(([floor, status]) => ({ floor, status }));
}

function coverage(overrides: Partial<CoverageViewModel> = {}): CoverageViewModel {
  return {
    runs: [],
    processedCount: 0,
    runningCount: 0,
    errorCount: 0,
    untrackedCount: 0,
    totalCount: 0,
    ...overrides,
  };
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

describe("validateBlockSize（每批楼层数输入校验）", () => {
  it("空输入 = 默认块大小（20，与 service 同值）", () => {
    expect(validateBlockSize("")).toEqual({ kind: "ok", value: 20 });
    expect(validateBlockSize("   ")).toEqual({ kind: "ok", value: 20 });
  });

  it("合法正整数 → ok（含边界 1）", () => {
    expect(validateBlockSize("1")).toEqual({ kind: "ok", value: 1 });
    expect(validateBlockSize("50")).toEqual({ kind: "ok", value: 50 });
  });

  it("非整数/小于 1 → error 且原因可读", () => {
    expect(validateBlockSize("abc")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("整数"),
    });
    expect(validateBlockSize("2.5")).toMatchObject({
      kind: "error",
      message: expect.stringContaining("整数"),
    });
    expect(validateBlockSize("0")).toMatchObject({
      kind: "error",
      message: expect.stringContaining(">= 1"),
    });
    expect(validateBlockSize("-3")).toMatchObject({
      kind: "error",
      message: expect.stringContaining(">= 1"),
    });
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

describe("buildCoverageViewModel（逐消息覆盖视图：已处理/任务中/出错/未计划）", () => {
  it("无台账无活动任务：全部未计划，单 run 覆盖整个对话", () => {
    const view = buildCoverageViewModel({ ledger: [], activeRange: undefined, chatLength: 6 });
    expect(view).toEqual({
      runs: [{ status: "untracked", from: 0, to: 5 }],
      processedCount: 0,
      runningCount: 0,
      errorCount: 0,
      untrackedCount: 6,
      totalCount: 6,
    });
  });

  it("台账 processed/error 分类正确；连续同类别合并为 run", () => {
    const view = buildCoverageViewModel({
      ledger: entries([0, "processed"], [1, "error"], [3, "processed"]),
      activeRange: undefined,
      chatLength: 8,
    });
    expect(view.runs).toEqual([
      { status: "processed", from: 0, to: 0 },
      { status: "error", from: 1, to: 1 },
      { status: "untracked", from: 2, to: 2 },
      { status: "processed", from: 3, to: 3 },
      { status: "untracked", from: 4, to: 7 },
    ]);
    expect(view).toMatchObject({ processedCount: 2, errorCount: 1, untrackedCount: 5 });
  });

  it("台账无行且在活动任务范围内 = 任务中；范围外 = 未计划", () => {
    const view = buildCoverageViewModel({
      ledger: entries([0, "processed"]),
      activeRange: { from: 1, to: 4 },
      chatLength: 6,
    });
    expect(view.runs).toEqual([
      { status: "processed", from: 0, to: 0 },
      { status: "running", from: 1, to: 4 },
      { status: "untracked", from: 5, to: 5 },
    ]);
    expect(view).toMatchObject({ processedCount: 1, runningCount: 4, untrackedCount: 1 });
  });

  it("活动范围内的 error/processed 楼层保持台账类别（出错可重试、已提交保留语义不变）", () => {
    const view = buildCoverageViewModel({
      ledger: entries([2, "error"], [3, "processed"]),
      activeRange: { from: 0, to: 4 },
      chatLength: 6,
    });
    expect(view.runs).toEqual([
      { status: "running", from: 0, to: 1 },
      { status: "error", from: 2, to: 2 },
      { status: "processed", from: 3, to: 3 },
      { status: "running", from: 4, to: 4 },
      { status: "untracked", from: 5, to: 5 },
    ]);
    expect(view).toMatchObject({ runningCount: 3, errorCount: 1, processedCount: 1 });
  });

  it("空对话：无 run，全部计数 0", () => {
    expect(buildCoverageViewModel({ ledger: [], activeRange: undefined, chatLength: 0 })).toEqual(
      coverage(),
    );
  });

  it("陈旧台账楼层（超出当前对话长度）不参与覆盖视图（按 live 楼层渲染）", () => {
    const view = buildCoverageViewModel({
      ledger: entries([0, "processed"], [9, "error"]),
      activeRange: undefined,
      chatLength: 5,
    });
    expect(view).toEqual({
      runs: [
        { status: "processed", from: 0, to: 0 },
        { status: "untracked", from: 1, to: 4 },
      ],
      processedCount: 1,
      runningCount: 0,
      errorCount: 0,
      untrackedCount: 4,
      totalCount: 5,
    });
  });
});

describe("buildTasksTabViewModel（任务 Tab 视图模型：触发表单 + 活动任务 + 覆盖视图 + 历史列表）", () => {
  const base = {
    chatLength: 8,
    ledger: entries([0, "processed"], [5, "error"]),
    activeTask: undefined as FillTaskView | undefined,
    historyTasks: [] as readonly FillTaskView[],
    cleaning: { selectedListId: undefined as string | undefined, lists: [] as readonly CleaningRuleList[] },
  };

  it("无活动任务：可触发，表单预填首个未处理范围", () => {
    const view: TasksTabViewModel = buildTasksTabViewModel({
      ...base,
      historyTasks: [
        task({
          runId: "run-failed",
          status: "failed",
          errorMessage: "消息块 [0, 19] 内没有可处理的消息",
          from: 0,
          to: 3,
          processedCount: 0,
          totalCount: 4,
        }),
      ],
    });
    expect(view).toMatchObject({
      canTrigger: true,
      hasActiveTask: false,
      unprocessedHint: "未处理楼层 1–4 · 共 6 层",
      defaultFrom: "1",
      defaultTo: "4",
    });
  });

  it("有活动任务：不可触发，展示运行中状态与范围，覆盖视图含任务中类别", () => {
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
    });    // 覆盖视图：0 已处理、5 出错（台账为准）；2–7 内未台账楼层（2,3,4,6,7）任务中；1 未计划
    expect(view.coverage).toMatchObject({
      processedCount: 1,
      errorCount: 1,
      runningCount: 5,
      untrackedCount: 1,
    });
  });

  it("历史列表：只列终态任务，条目带状态/范围/时间/进度/错误，失败与中断可重试", () => {
    const view = buildTasksTabViewModel({
      ...base,
      activeTask: task({ runId: "run-active", from: 2, to: 7 }),
      historyTasks: [
        task({ runId: "run-active", from: 2, to: 7 }), // 运行中：被过滤
        task({
          runId: "run-failed",
          status: "failed",
          errorMessage: "模型炸了",
          from: 0,
          to: 3,
          processedCount: 2,
          totalCount: 4,
        }),
        task({
          runId: "run-interrupted",
          status: "interrupted",
          from: 4,
          to: 7,
          processedCount: 1,
          totalCount: 4,
        }),
        task({ runId: "run-succeeded", status: "succeeded", from: 0, to: 1 }),
      ],
    });
    expect(view.history.map((item) => item.runId)).toEqual([
      "run-failed",
      "run-interrupted",
      "run-succeeded",
    ]);
    expect(view.history[0]).toEqual({
      runId: "run-failed",
      status: "failed",
      statusLabel: "失败",
      kindLabel: "填表",
      rangeText: "楼层 0–3",
      timeText: "2026-07-30 01:02",
      progressText: "已处理 2/4 层",
      errorMessage: "模型炸了",
      retryable: true,
    });
    expect(view.history[1]).toMatchObject({ statusLabel: "已中断", retryable: true });
    expect(view.history[2]).toMatchObject({ statusLabel: "已完成", retryable: false });
  });

  it("无历史任务：history 为空", () => {
    const view = buildTasksTabViewModel(base);
    expect(view.history).toEqual([]);
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

  it("空对话：不可触发，提示没有消息，覆盖视图为空", () => {
    const view = buildTasksTabViewModel({ ...base, chatLength: 0 });
    expect(view).toMatchObject({
      canTrigger: false,
      unprocessedHint: null,
      defaultFrom: "",
      defaultTo: "",
    });
    expect(view.noMessages).toBe(true);
    expect(view.coverage.totalCount).toBe(0);
  });

  it("清洗提示：未选择 / 列表已删除（悬空）/ 生效中（ticket 22）", () => {
    const noSelection = buildTasksTabViewModel(base);
    expect(noSelection.cleaningHint).toBe("未启用清洗");

    const dangling = buildTasksTabViewModel({
      ...base,
      cleaning: { selectedListId: "deleted", lists: [{ id: "l1", name: "我的清洗", rules: [] }] },
    });
    expect(dangling.cleaningHint).toBe("所选清洗规则列表不存在，未清洗");

    const active = buildTasksTabViewModel({
      ...base,
      cleaning: { selectedListId: "l1", lists: [{ id: "l1", name: "我的清洗", rules: [] }] },
    });
    expect(active.cleaningHint).toBe("清洗：我的清洗");
  });
});


describe("初始化填表（spec init-fill）：任务类型标签与视图", () => {
  function initTask(overrides: Partial<FillTaskView> = {}): FillTaskView {
    return task({
      kind: "init",
      initText: "爱丽丝是咖啡店店员",
      from: 0,
      to: 0,
      blockSize: 1,
      processedCount: 0,
      totalCount: 1,
      ...overrides,
    } as FillTaskView);
  }

  it("taskStatusViewModel：init 任务运行中显示初始化文案，不显示楼层进度", () => {
    expect(taskStatusViewModel(initTask())).toEqual({ label: "运行中", detail: "正在初始化…" });
    expect(taskStatusViewModel(initTask({ status: "succeeded" }))).toEqual({
      label: "已完成",
      detail: "",
    });
    expect(
      taskStatusViewModel(initTask({ status: "failed", errorMessage: "模型炸了" })),
    ).toEqual({ label: "失败", detail: "模型炸了" });
  });

  it("buildTasksTabViewModel：init 活动任务 activeRange 显示「初始化填表」而非楼层范围", () => {
    const view = buildTasksTabViewModel({
      chatLength: 6,
      ledger: [],
      activeTask: initTask({ status: "running" }),
      historyTasks: [],
      cleaning: { selectedListId: undefined, lists: [] },
    });
    expect(view).toMatchObject({
      hasActiveTask: true,
      activeTaskLabel: "运行中",
      activeTaskDetail: "正在初始化…",
      activeRange: "初始化填表",
      canTrigger: false,
      canTriggerInit: false,
    });
  });

  it("buildTasksTabViewModel：无活动任务时 canTriggerInit 为 true，不依赖对话消息数", () => {
    const empty = buildTasksTabViewModel({
      chatLength: 0,
      ledger: [],
      activeTask: undefined,
      historyTasks: [],
      cleaning: { selectedListId: undefined, lists: [] },
    });
    expect(empty.canTriggerInit).toBe(true);
    expect(empty.canTrigger).toBe(false);
    expect(empty.noMessages).toBe(true);
  });

  it("历史条目：init 任务显示「初始化」类型标签与进度文本，不显示楼层范围", () => {
    const view = buildTasksTabViewModel({
      chatLength: 6,
      ledger: [],
      activeTask: undefined,
      historyTasks: [initTask({ status: "succeeded", runId: "run-init" })],
      cleaning: { selectedListId: undefined, lists: [] },
    });
    expect(view.history).toHaveLength(1);
    expect(view.history[0]).toEqual({
      runId: "run-init",
      status: "succeeded",
      statusLabel: "已完成",
      kindLabel: "初始化",
      rangeText: "初始化填表",
      timeText: "2026-07-30 01:02",
      progressText: "初始化",
      errorMessage: null,
      retryable: false,
    });
  });

  it("历史条目：楼层任务保持原样，类型标签为「填表」", () => {
    const view = buildTasksTabViewModel({
      chatLength: 6,
      ledger: [],
      activeTask: undefined,
      historyTasks: [task({ status: "succeeded", runId: "run-floor" })],
      cleaning: { selectedListId: undefined, lists: [] },
    });
    expect(view.history[0]).toMatchObject({
      kindLabel: "填表",
      rangeText: "楼层 0–9",
      progressText: "已处理 4/10 层",
    });
  });
});
