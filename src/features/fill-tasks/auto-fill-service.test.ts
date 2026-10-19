import type { FillTaskSubmitInput } from "./fill-task-service.ts";
import { describe, expect, it, vi } from "vitest";
import { AutoFillService } from "./auto-fill-service.ts";
import {
  DEFAULT_AUTO_FILL_SETTINGS,
  autoFillRange,
  type AutoFillChatState,
  type AutoFillSettings,
} from "./auto-fill-settings.ts";
import type { FillTaskView, FloorLedgerEntry } from "./fill-task.ts";
import type { MemorySpaceId } from "../memory/index.ts";

function setup(overrides: Partial<AutoFillSettings> = {}) {
  let global = {
    ...DEFAULT_AUTO_FILL_SETTINGS,
    mode: "auto" as AutoFillSettings["mode"],
    ...overrides,
  };
  let state: AutoFillChatState = { overrides: {}, pausedReason: null };
  let current:
    { identity: string; spaceId: MemorySpaceId; chatLength: number; aiFloor: number } | undefined =
    { identity: "a", spaceId: "space" as MemorySpaceId, chatLength: 32, aiFloor: 31 };
  let active: FillTaskView | undefined;
  let recent: FillTaskView[] = [];
  let runSequence = 0;
  let ledger: FloorLedgerEntry[] = [{ floor: 20, status: "processed" }];
  const tasks = {
    submit: vi.fn(async (input: FillTaskSubmitInput) => {
      active = {
        ...input,
        blockSize: input.blockSize!,
        automatic: true,
        runId: runSequence++ === 0 ? "run" : `run-${runSequence}`,
        kind: "floor",
        initText: null,
        chatId: "a",
        status: "running",
        errorMessage: null,
        createdAt: "now",
        updatedAt: "now",
        processedCount: 0,
        totalCount: input.to - input.from + 1,
      };
      return active!;
    }),
    activeTask: vi.fn(async () => active),
    recentTasks: vi.fn(async () => recent),
    ledgerStatuses: vi.fn(async () => ledger),
    cancel: vi.fn(async (_spaceId: MemorySpaceId, _runId: string, reason?: "chat-changed") => {
      const stopped = {
        ...active!,
        status: "interrupted" as const,
        ...(reason ? { interruptionReason: reason } : {}),
      };
      recent = [stopped];
      active = undefined;
      return stopped;
    }),
  };
  const notify = vi.fn();
  const confirmResume = vi.fn(async () => false);
  const reportError = vi.fn();
  const ports = {
    tasks,
    chatStore: {
      read: () => state,
      write: (value: AutoFillChatState) => {
        state = value;
      },
    },
    globalSettings: () => global,
    current: () => current,
    notify,
    confirmResume,
    dismissReminder: vi.fn(),
    reportError,
  };
  const service = new AutoFillService(ports);
  return {
    reopen: () => new AutoFillService(ports),
    service,
    tasks,
    notify,
    confirmResume,
    reportError,
    state: () => state,
    setGlobal: (value: Partial<AutoFillSettings>) => {
      global = { ...global, ...value };
    },
    setCurrent: (value: typeof current) => {
      current = value;
    },
    setLedger: (value: FloorLedgerEntry[]) => {
      ledger = value;
    },
    finish: (status: "failed" | "succeeded" | "interrupted") => {
      recent = [{ ...active!, status, errorMessage: status === "failed" ? "失败原因" : null }];
      active = undefined;
    },
  };
}

describe("自动填表调度", () => {
  it("忽略历史空洞与 error，从最高 processed 下一层计算，开关决定末层", () => {
    const ledger: FloorLedgerEntry[] = [
      { floor: 10, status: "processed" },
      { floor: 25, status: "processed" },
      { floor: 29, status: "error" },
    ];
    expect(autoFillRange(ledger, 31, false)).toEqual({ from: 26, to: 30 });
    expect(autoFillRange(ledger, 31, true)).toEqual({ from: 26, to: 31 });
    expect(autoFillRange([], 0, false)).toBeUndefined();
    expect(autoFillRange([], 0, true)).toEqual({ from: 0, to: 0 });
  });

  it("达到间隔提交全部积压，重复检查保持单任务", async () => {
    const h = setup({ blockSize: 4 });
    h.service.kick();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    expect(h.tasks.submit.mock.calls[0]![0]).toMatchObject({ from: 21, to: 30, blockSize: 4 });
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.activeTask).toHaveBeenCalledTimes(3));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
  });

  it("生成未完成时不调度，完成后仅提醒，重复检查不重复通知", async () => {
    const h = setup({ mode: "remind" });
    h.service.generationStarted();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.activeTask).toHaveBeenCalled());
    expect(h.notify).not.toHaveBeenCalled();
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.activeTask).toHaveBeenCalledTimes(3));
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.tasks.submit).not.toHaveBeenCalled();
  });

  it("失败耗尽后持久暂停，新回复不启动，显式恢复后再检查", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.finish("failed");
    h.service.kick();
    await vi.waitFor(() => expect(h.state().pausedReason).toBe("失败原因"));
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.tasks.activeTask).toHaveBeenCalledTimes(3));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
    h.service.resume();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(2));
  });

  it("逐项覆盖，清空恢复继承，显式关闭和 false 保留", () => {
    const h = setup({ includeCurrent: true });
    h.service.saveOverrides({ mode: "off", includeCurrent: false, blockSize: 4 });
    h.setGlobal({ interval: 30, blockSize: 9 });
    expect(h.service.settings()).toMatchObject({
      mode: "off",
      includeCurrent: false,
      blockSize: 4,
      interval: 30,
    });
    h.service.saveOverrides({ mode: "off" });
    expect(h.service.settings()).toMatchObject({ mode: "off", includeCurrent: true, blockSize: 9 });
  });

  it("切换模式停止当前任务且不设置暂停", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.setGlobal({ mode: "off" });
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.cancel).toHaveBeenCalledTimes(1));
    expect(h.state().pausedReason).toBeNull();
  });

  it("对话切换取消旧任务，旧任务 canContinue 立即失效", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    const policy = h.tasks.submit.mock.calls[0]![0].automatic;
    await h.service.chatChanged();
    expect(policy!.canContinue()).toBe(false);
    expect(h.tasks.cancel).toHaveBeenCalledTimes(1);
    expect(h.state().pausedReason).toBeNull();
  });

  it("启动预检失败直接暂停，不自动循环提交", async () => {
    const h = setup();
    h.tasks.submit.mockRejectedValue(new Error("连接缺失"));
    h.service.kick();
    await vi.waitFor(() => expect(h.state().pausedReason).toBe("连接缺失"));
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.activeTask).toHaveBeenCalledTimes(2));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
  });

  it("最终失败立即持久暂停，切走聊天不丢失暂停状态", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.tasks.submit.mock.calls[0]![0].automatic!.onFailure!("重试用尽");
    expect(h.state().pausedReason).toBe("重试用尽");
    await h.service.chatChanged();
    expect(h.state().pausedReason).toBe("重试用尽");
  });

  it("系统切换模式造成任务中断时不进入主动暂停", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.finish("failed");
    h.setGlobal({ mode: "off" });
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.activeTask).toHaveBeenCalledTimes(2));
    expect(h.state().pausedReason).toBeNull();
  });

  it("切换返回后先询问，拒绝后保持暂停，手动继续只续跑原范围", async () => {
    const h = setup({ blockSize: 4 });
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.setLedger([{ floor: 25, status: "processed" }]);
    await h.service.chatChanged();
    expect(h.tasks.cancel).toHaveBeenCalledWith("space", "run", "chat-changed");
    h.service.chatReady();
    await vi.waitFor(() => expect(h.confirmResume).toHaveBeenCalledTimes(1));
    expect(h.state().pendingResumeTask).toMatchObject({ from: 21, to: 30, blockSize: 4 });
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.tasks.activeTask.mock.calls.length).toBeGreaterThan(3));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
    expect(h.confirmResume).toHaveBeenCalledTimes(1);
    await h.service.resume();
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 26, to: 30, blockSize: 4 });
    expect(h.state().pendingResumeTask).toBeUndefined();
    expect(h.state().pausedReason).toBeNull();
  });

  it("确认继续不受间隔限制，也不把新增积压纳入原任务", async () => {
    const h = setup({ blockSize: 4 });
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.setLedger([{ floor: 28, status: "processed" }]);
    await h.service.chatChanged();
    h.setCurrent({ identity: "a", spaceId: "space" as MemorySpaceId, chatLength: 40, aiFloor: 39 });
    h.confirmResume.mockResolvedValue(true);
    h.service.chatReady();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(2));
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 29, to: 30, blockSize: 4 });
  });

  it("暂不继续后再次进入仍会询问，确认期间切走不会启动旧任务", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    await h.service.chatChanged();
    h.service.chatReady();
    await vi.waitFor(() => expect(h.confirmResume).toHaveBeenCalledTimes(1));
    await h.service.chatChanged();
    let decide!: (value: boolean) => void;
    h.confirmResume.mockImplementation(
      () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    );
    h.service.chatReady();
    await vi.waitFor(() => expect(h.confirmResume).toHaveBeenCalledTimes(2));
    await h.service.chatChanged();
    h.setCurrent({ identity: "b", spaceId: "other" as MemorySpaceId, chatLength: 32, aiFloor: 31 });
    decide(true);
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.activeTask.mock.calls.length).toBeGreaterThan(4));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
  });

  it("暂停期间暂存后续任务，取消当前任务后按顺序执行，保留任务参数和配置", async () => {
    const h = setup({ blockSize: 4 });
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.setLedger([{ floor: 25, status: "processed" }]);
    await h.service.chatChanged();
    h.service.chatReady();
    await vi.waitFor(() => expect(h.confirmResume).toHaveBeenCalledTimes(1));
    h.setCurrent({ identity: "a", spaceId: "space" as MemorySpaceId, chatLength: 42, aiFloor: 41 });
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.state().stagedTasks).toHaveLength(1));
    h.setCurrent({ identity: "a", spaceId: "space" as MemorySpaceId, chatLength: 52, aiFloor: 51 });
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.state().stagedTasks).toHaveLength(2));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
    expect(h.state().stagedTasks?.map((task) => [task.from, task.to])).toEqual([
      [31, 40],
      [41, 50],
    ]);
    h.setGlobal({ blockSize: 8 });
    const config = structuredClone(h.service.settings());
    await h.service.cancelPausedTask();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(2));
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 31, to: 40, blockSize: 4 });
    expect(h.service.settings()).toEqual(config);
    expect(h.state().overrides).toEqual({});
    expect(h.state().pendingResumeTask).toBeUndefined();
    h.setLedger([{ floor: 40, status: "processed" }]);
    h.finish("succeeded");
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(3));
    expect(h.tasks.submit.mock.calls[2]![0]).toMatchObject({ from: 41, to: 50, blockSize: 4 });
  });

  it("没有暂存任务时取消只回到空闲，重复检查与重新进入不重建旧任务", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    await h.service.chatChanged();
    h.service.chatReady();
    await vi.waitFor(() => expect(h.confirmResume).toHaveBeenCalledTimes(1));
    await h.service.cancelPausedTask();
    h.service.kick();
    await h.service.chatChanged();
    h.service.chatReady();
    await vi.waitFor(() => expect(h.tasks.recentTasks.mock.calls.length).toBeGreaterThan(2));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
    expect(h.confirmResume).toHaveBeenCalledTimes(1);
    expect(h.state().pausedReason).toBeNull();
  });

  it("取消运行中任务会启动已暂存的下一个任务", async () => {
    const h = setup();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.setCurrent({ identity: "a", spaceId: "space" as MemorySpaceId, chatLength: 42, aiFloor: 41 });
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.state().stagedTasks).toHaveLength(1));
    await h.service.cancel();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(2));
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 31, to: 40 });
    expect(h.state().pausedReason).toBeNull();
  });
  it("刷新后保留运行快照与暂存队列，只续跑未完成楼层", async () => {
    const h = setup({ blockSize: 4 });
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(1));
    h.setCurrent({ identity: "a", spaceId: "space" as MemorySpaceId, chatLength: 42, aiFloor: 41 });
    h.service.generationEnded();
    await vi.waitFor(() => expect(h.state().stagedTasks).toHaveLength(1));
    h.setLedger([{ floor: 25, status: "processed" }]);
    h.finish("interrupted");
    const reopened = h.reopen();
    reopened.kick();
    await vi.waitFor(() => expect(h.tasks.submit).toHaveBeenCalledTimes(2));
    expect(h.tasks.submit.mock.calls[1]![0]).toMatchObject({ from: 26, to: 30, blockSize: 4 });
    expect(h.state().stagedTasks?.map((task) => [task.from, task.to])).toEqual([[31, 40]]);
  });

  it("启动失败的暂存任务也能取消，取消后不立即重复提交", async () => {
    const h = setup();
    h.tasks.submit.mockRejectedValue(new Error("连接缺失"));
    h.service.kick();
    await vi.waitFor(() => expect(h.state().pausedReason).toBe("连接缺失"));
    expect(h.state().stagedTasks).toHaveLength(1);
    await h.service.cancelPausedTask();
    h.service.kick();
    await vi.waitFor(() => expect(h.tasks.activeTask.mock.calls.length).toBeGreaterThan(2));
    expect(h.tasks.submit).toHaveBeenCalledTimes(1);
    expect(h.state().stagedTasks).toHaveLength(0);
    expect(h.state().pausedReason).toBeNull();
  });
});
