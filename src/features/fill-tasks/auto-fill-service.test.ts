import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "../memory/index.ts";
import type { FillTask, FillTaskView, FloorLedgerEntry } from "./fill-task.ts";
import type { FillTaskSubmitInput } from "./fill-task-service.ts";
import { AutoFillService } from "./auto-fill-service.ts";
import {
  autoFillRange,
  DEFAULT_AUTO_FILL_SETTINGS,
  type AutoFillChatState,
  type AutoFillSettings,
} from "./auto-fill-settings.ts";

function setup(overrides: Partial<AutoFillSettings> = {}, initialState?: AutoFillChatState) {
  let settings = { ...DEFAULT_AUTO_FILL_SETTINGS, mode: "auto" as const, ...overrides };
  let state: AutoFillChatState = initialState ?? { overrides: {}, pausedReason: null };
  let current = {
    identity: "a",
    chatId: "a",
    spaceId: "space" as MemorySpaceId,
    chatLength: 32,
    aiFloor: 31,
  };
  let ledger: readonly FloorLedgerEntry[] = [{ floor: 20, status: "processed" }];
  let pending: FillTaskView[] = [];
  const recent: FillTaskView[] = [];
  let seq = 0;
  const tasks = {
    submit: vi.fn(async (input: FillTaskSubmitInput): Promise<FillTaskView> => {
      const task: FillTaskView = {
        memorySpaceId: input.memorySpaceId,
        from: input.from,
        to: input.to,
        blockSize: input.blockSize!,
        automatic: !!input.automatic,
        runId: `run-${++seq}`,
        kind: "floor",
        initText: null,
        chatId: "a",
        status: "queued",
        errorMessage: null,
        createdAt: "now",
        updatedAt: "now",
        processedCount: 0,
        totalCount: input.to - input.from + 1,
      };
      pending.push(task);
      return task;
    }),
    pendingTasks: vi.fn(async () => pending),
    activeTask: vi.fn(async () => pending.find((task) => task.status === "running")),
    recentTasks: vi.fn(async () => recent),
    ledgerStatuses: vi.fn(async () => ledger),
    cancel: vi.fn(async (_id: MemorySpaceId, runId: string, reason?: "chat-changed") => {
      const task = pending.find((item) => item.runId === runId)!;
      const interrupted: FillTaskView = {
        ...task,
        status: "interrupted",
        interruptionReason: reason,
        blocksQueue: reason === "chat-changed",
      };
      pending = pending.filter((item) => item.runId !== runId);
      if (interrupted.blocksQueue) pending.unshift(interrupted);
      recent.unshift(interrupted);
      return interrupted;
    }),
    retry: vi.fn(async (_id: MemorySpaceId, runId: string) =>
      pending.find((task) => task.runId === runId)!,
    ),
    suspend: vi.fn(),
    kick: vi.fn(),
  };
  const notify = vi.fn();
  const confirmResume = vi.fn(async () => false);
  const reportError = vi.fn();
  const dismissReminder = vi.fn();
  const hideFloors = vi.fn(async (_identity: string, _to: number) => {});
  const service = new AutoFillService({
    tasks,
    chatStore: {
      read: () => state,
      write: (value) => {
        state = value;
      },
    },
    globalSettings: () => settings,
    current: () => current,
    notify,
    confirmResume,
    reportError,
    dismissReminder,
    hideFloors,
  });
  return {
    service,
    tasks,
    notify,
    confirmResume,
    reportError,
    dismissReminder,
    hideFloors,
    state: () => state,
    setSettings: (value: Partial<AutoFillSettings>) => {
      settings = { ...settings, ...value };
    },
    setCurrent: (value: Partial<typeof current>) => {
      current = { ...current, ...value };
    },
    setPending: (value: FillTaskView[]) => {
      pending = value;
    },
    setLedger: (value: FloorLedgerEntry[]) => {
      ledger = value;
    },
    finish: (status: "failed" | "succeeded") => {
      const task = {
        ...pending[0]!,
        status,
        blocksQueue: status === "failed",
        errorMessage: status === "failed" ? "失败原因" : null,
      };
      recent.unshift(task);
      pending = status === "failed" ? [task, ...pending.slice(1)] : pending.slice(1);
    },
  };
}

async function check(h: ReturnType<typeof setup>) {
  const before = h.tasks.pendingTasks.mock.calls.length;
  const kicks = h.tasks.kick.mock.calls.length;
  h.service.kick();
  await vi.waitFor(() => expect(h.tasks.pendingTasks.mock.calls.length).toBeGreaterThan(before));
  await vi.waitFor(() => expect(h.tasks.kick.mock.calls.length).toBeGreaterThan(kicks));
}

describe("自动填表入队", () => {
  it("从最高 processed 下一层计算范围，忽略历史空洞和 error", () => {
    const ledger: FloorLedgerEntry[] = [
      { floor: 25, status: "processed" },
      { floor: 29, status: "error" },
    ];
    expect(autoFillRange(ledger, 31, 1)).toEqual({ from: 26, to: 30 });
    expect(autoFillRange(ledger, 31, 0)).toEqual({ from: 26, to: 31 });
    expect(autoFillRange([], 0, 1)).toBeUndefined();
    expect(autoFillRange(ledger, 31, 5)).toEqual({ from: 26, to: 26 });
    expect(autoFillRange(ledger, 31, 6)).toBeUndefined();
    expect(autoFillRange([], 3, 5)).toBeUndefined();
  });

  it.each(["auto", "remind"] as const)("%s 按延迟后的待填范围判断触发间隔", async (mode) => {
    const h = setup({ mode, delayFloors: 5, interval: 5 });
    h.setCurrent({ chatLength: 30, aiFloor: 29 });
    await check(h);
    expect(h.tasks.submit).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    h.setCurrent({ chatLength: 31, aiFloor: 30 });
    await check(h);
    if (mode === "auto") {
      expect(h.tasks.submit.mock.calls[0]![0]).toMatchObject({ from: 21, to: 25 });
    } else {
      expect(h.tasks.submit).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "reminder", message: "待填 #21–#25，共 5 层" }),
      );
    }
  });

  it("修改延迟保留已入队范围，新增任务使用新延迟", async () => {
    const h = setup();
    await check(h);
    h.service.saveOverrides({ delayFloors: 5 });
    await check(h);
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
    expect((await h.tasks.pendingTasks())[0]).toMatchObject({ from: 21, to: 30 });
    h.setCurrent({ chatLength: 46, aiFloor: 45 });
    await check(h);
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 31, to: 40 });
  });

  it("达到间隔入队，重复检查不会重复提交同一范围", async () => {
    const h = setup({ blockSize: 4 });
    await check(h);
    await check(h);
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
    expect(h.tasks.submit.mock.calls[0]![0]).toMatchObject({ from: 21, to: 30, blockSize: 4 });
    expect(h.state().stagedTasks).toBeUndefined();
    expect(h.state().inFlightTask).toBeUndefined();
  });

  it("手动任务运行时自动任务立即入同一队列，后续范围继续按序入队", async () => {
    const h = setup();
    const manual = await h.tasks.submit({
      memorySpaceId: "space" as MemorySpaceId,
      from: 21,
      to: 30,
      blockSize: 4,
    });
    h.setPending([{ ...manual, status: "running" }]);
    h.setCurrent({ chatLength: 42, aiFloor: 41 });
    await check(h);
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 31, to: 40 });
    h.setCurrent({ chatLength: 52, aiFloor: 51 });
    await check(h);
    expect(h.tasks.submit.mock.calls[2]![0]).toMatchObject({ from: 41, to: 50 });
  });

  it("失败项仍保留范围，暂停期间新增任务也入队，恢复交给共享队列", async () => {
    const h = setup();
    await check(h);
    h.finish("failed");
    h.setCurrent({ chatLength: 42, aiFloor: 41 });
    await check(h);
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 31, to: 40 });
    await h.tasks.retry("space" as MemorySpaceId, "run-1");
    expect(h.tasks.retry).toHaveBeenCalledWith("space", "run-1");
  });

  it("生成期间暂停启动队列，完整回复结束后才计算并提交范围", async () => {
    const h = setup();
    h.service.generationStarted();
    h.service.kick();
    expect(h.tasks.suspend).toHaveBeenCalledOnce();
    expect(h.tasks.submit).not.toHaveBeenCalled();
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledOnce());
  });

  it("仅提醒不入队，重复检查不重复提醒", async () => {
    const h = setup({ mode: "remind" });
    await check(h);
    await check(h);
    expect(h.tasks.submit).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledOnce();
  });

  it("关闭自动填表会取消自动等待项，保留手动项", async () => {
    const h = setup();
    await check(h);
    const manual = await h.tasks.submit({
      memorySpaceId: "space" as MemorySpaceId,
      from: 0,
      to: 1,
    });
    h.setSettings({ mode: "off" });
    await check(h);
    expect(h.tasks.cancel).toHaveBeenCalledWith("space", "run-1");
    expect(await h.tasks.pendingTasks()).toEqual([manual]);
  });

  it("切换对话中断运行项，返回后只询问一次，拒绝仍保留阻塞项", async () => {
    const h = setup();
    await check(h);
    const first = (await h.tasks.pendingTasks())[0]!;
    h.setPending([{ ...first, status: "running" }]);
    await h.service.chatChanged();
    expect(h.tasks.cancel).toHaveBeenCalledWith("space", first.runId, "chat-changed");
    h.service.chatReady();
    await vi.waitFor(() => expect(h.confirmResume).toHaveBeenCalledOnce());
    await check(h);
    expect(h.confirmResume).toHaveBeenCalledOnce();
    expect((await h.tasks.pendingTasks())[0]!.blocksQueue).toBe(true);
    await h.tasks.cancel("space" as MemorySpaceId, first.runId);
    expect(h.tasks.cancel).toHaveBeenCalledWith("space", first.runId);
  });

  it("覆盖配置保留显式关闭和延迟层数，清空后继承全局设置", () => {
    const h = setup({ delayFloors: 0 });
    h.service.saveOverrides({ mode: "off", delayFloors: 1, blockSize: 4 });
    h.setSettings({ blockSize: 8 });
    expect(h.service.settings()).toMatchObject({
      mode: "off",
      delayFloors: 1,
      blockSize: 4,
    });
    h.service.saveOverrides({ mode: "off" });
    expect(h.service.settings()).toMatchObject({ delayFloors: 0, blockSize: 8 });
  });
  it("旧暂存列表首次载入转入共享队列，删除旧状态并保留每项参数", async () => {
    const settings = { ...DEFAULT_AUTO_FILL_SETTINGS, mode: "auto" as const, blockSize: 4 };
    // 模拟新增自动隐藏选项之前保存的聊天暂存快照。
    Reflect.deleteProperty(settings, "hideAfterSuccess");
    Reflect.deleteProperty(settings, "keepRecentFloors");
    const spaceId = "space" as MemorySpaceId;
    const h = setup(
      {},
      {
        overrides: {},
        pausedReason: "旧任务失败",
        inFlightTask: { memorySpaceId: spaceId, from: 11, to: 25, settings },
        stagedTasks: [{ memorySpaceId: spaceId, from: 26, to: 30, settings }],
        lastScheduled: { memorySpaceId: spaceId, to: 30 },
      },
    );
    await check(h);
    expect(
      h.tasks.submit.mock.calls.map(([input]) => [input.from, input.to, input.blockSize]),
    ).toEqual([
      [21, 25, 4],
      [26, 30, 4],
    ]);
    expect((await h.tasks.pendingTasks()).map((task) => [task.status, !!task.blocksQueue])).toEqual(
      [
        ["interrupted", true],
        ["queued", false],
      ],
    );
    expect(h.state().inFlightTask).toBeUndefined();
    expect(h.state().stagedTasks).toBeUndefined();
    await check(h);
    expect(h.tasks.submit).toHaveBeenCalledTimes(2);
  });
});

describe("自动填表成功后隐藏", () => {
  const task: FillTask = {
    runId: "completed-run",
    memorySpaceId: "space" as MemorySpaceId,
    kind: "floor",
    initText: null,
    automatic: true,
    chatId: "a",
    from: 0,
    to: 80,
    blockSize: 20,
    status: "succeeded",
    errorMessage: null,
    createdAt: "now",
    updatedAt: "now",
  };

  it.each([
    { keep: 10, processed: 95, end: 90 },
    { keep: 10, processed: 80, end: 80 },
    { keep: 0, processed: 100, end: 100 },
    { keep: 101, processed: 100, end: undefined },
    { keep: 0, processed: -1, end: undefined },
  ])("保留 $keep 层、最大已填 $processed 时隐藏至 $end", async ({ keep, processed, end }) => {
    const h = setup({ hideAfterSuccess: true, keepRecentFloors: keep });
    h.setCurrent({ chatLength: 101, aiFloor: 99 });
    h.setLedger([
      ...(processed >= 0 ? [{ floor: processed, status: "processed" as const }] : []),
      { floor: 100, status: "error" },
    ]);
    await h.service.taskSucceeded(task);
    if (end === undefined) expect(h.hideFloors).not.toHaveBeenCalled();
    else expect(h.hideFloors).toHaveBeenCalledExactlyOnceWith("a", end);
  });

  it("默认关闭，且仅整次自动楼层填表成功触发", async () => {
    const h = setup();
    await h.service.taskSucceeded(task);
    h.setSettings({ hideAfterSuccess: true });
    await h.service.taskSucceeded({ ...task, automatic: false });
    await h.service.taskSucceeded({ ...task, kind: "init", initText: "初始化" });
    await h.service.taskSucceeded({ ...task, status: "failed" });
    await h.service.taskSucceeded({ ...task, status: "interrupted" });
    await h.service.taskSucceeded({ ...task, status: "running" });
    h.setSettings({ mode: "remind" });
    await h.service.taskSucceeded(task);
    expect(h.hideFloors).not.toHaveBeenCalled();
  });

  it("对话覆盖可关闭全局隐藏，也可单独覆盖保留层数", async () => {
    const h = setup(
      { hideAfterSuccess: true },
      {
        overrides: { hideAfterSuccess: false },
        pausedReason: null,
      },
    );
    await h.service.taskSucceeded(task);
    expect(h.hideFloors).not.toHaveBeenCalled();
    h.service.saveOverrides({ keepRecentFloors: 30 });
    await h.service.taskSucceeded(task);
    expect(h.hideFloors).toHaveBeenCalledExactlyOnceWith("a", 1);
  });

  it("读取台账时切换空间，或切走后返回同一对话，均跳过隐藏", async () => {
    const h = setup({ hideAfterSuccess: true });
    h.tasks.ledgerStatuses.mockImplementationOnce(async () => {
      h.setCurrent({ spaceId: "other-space" as MemorySpaceId });
      return [{ floor: 20, status: "processed" }];
    });
    await h.service.taskSucceeded(task);
    h.setCurrent({ spaceId: task.memorySpaceId });
    h.tasks.ledgerStatuses.mockImplementationOnce(async () => {
      await h.service.chatChanged();
      h.service.chatReady();
      return [{ floor: 20, status: "processed" }];
    });
    await h.service.taskSucceeded(task);
    expect(h.hideFloors).not.toHaveBeenCalled();
  });

  it("读取台账期间关闭隐藏，不再执行", async () => {
    const h = setup({ hideAfterSuccess: true });
    h.tasks.ledgerStatuses.mockImplementationOnce(async () => {
      h.setSettings({ hideAfterSuccess: false });
      return [{ floor: 20, status: "processed" }];
    });
    await h.service.taskSucceeded(task);
    expect(h.hideFloors).not.toHaveBeenCalled();
  });

  it("隐藏失败单独提示填表成功，后续完成轮询不覆盖失败提示", async () => {
    const h = setup({ hideAfterSuccess: true });
    await check(h);
    const submitted = h.tasks.submit.mock.results[0]!;
    const queued = await submitted.value;
    const error = new Error("聊天保存失败");
    h.hideFloors.mockRejectedValueOnce(error);
    h.finish("succeeded");
    await h.service.taskSucceeded({ ...queued, status: "succeeded" });
    await check(h);
    expect(h.reportError).toHaveBeenCalledWith(error);
    expect(h.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "failed",
        message: "自动填表已成功，隐藏楼层失败：聊天保存失败",
      }),
    );
    expect(h.tasks.retry).not.toHaveBeenCalled();
  });
});
