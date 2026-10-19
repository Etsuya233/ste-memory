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
  let ledger: FloorLedgerEntry[] = [{ floor: 20, status: "processed" }];
  const tasks = {
    submit: vi.fn(async (input: FillTaskSubmitInput) => {
      active = {
        ...input,
        blockSize: input.blockSize!,
        automatic: true,
        runId: "run",
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
    cancel: vi.fn(async () => {
      const stopped = { ...active!, status: "interrupted" as const };
      active = undefined;
      return stopped;
    }),
  };
  const notify = vi.fn();
  const reportError = vi.fn();
  const service = new AutoFillService({
    tasks,
    chatStore: {
      read: () => state,
      write: (value) => {
        state = value;
      },
    },
    globalSettings: () => global,
    current: () => current,
    notify,
    dismissReminder: vi.fn(),
    reportError,
  });
  return {
    service,
    tasks,
    notify,
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
    finish: (status: "failed" | "succeeded") => {
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
});
