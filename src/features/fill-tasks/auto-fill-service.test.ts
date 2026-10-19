import { describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "../memory/index.ts";
import type { FillTaskView, FloorLedgerEntry } from "./fill-task.ts";
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
  let current = { identity: "a", spaceId: "space" as MemorySpaceId, chatLength: 32, aiFloor: 31 };
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
  });
  return {
    service,
    tasks,
    notify,
    confirmResume,
    reportError,
    dismissReminder,
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
    expect(autoFillRange(ledger, 31, false)).toEqual({ from: 26, to: 30 });
    expect(autoFillRange(ledger, 31, true)).toEqual({ from: 26, to: 31 });
    expect(autoFillRange([], 0, false)).toBeUndefined();
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

  it("覆盖配置保留显式关闭和 false，清空后继承全局设置", () => {
    const h = setup({ includeCurrent: true });
    h.service.saveOverrides({ mode: "off", includeCurrent: false, blockSize: 4 });
    h.setSettings({ blockSize: 8 });
    expect(h.service.settings()).toMatchObject({
      mode: "off",
      includeCurrent: false,
      blockSize: 4,
    });
    h.service.saveOverrides({ mode: "off" });
    expect(h.service.settings()).toMatchObject({ includeCurrent: true, blockSize: 8 });
  });
  it("旧暂存列表首次载入转入共享队列，删除旧状态并保留每项参数", async () => {
    const settings = { ...DEFAULT_AUTO_FILL_SETTINGS, mode: "auto" as const, blockSize: 4 };
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
