import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemorySpaceId } from "../../../features/memory/index.ts";
import type { RecordsContext } from "../records-workspace.ts";
import { TasksWorkspace, type TasksServices } from "./tasks-workspace.ts";
const a: RecordsContext = { chatKey: "a", spaceId: "a" as MemorySpaceId, title: "A" };
const b: RecordsContext = { chatKey: "b", spaceId: "b" as MemorySpaceId, title: "B" };
function setup() {
  const services: TasksServices = {
    tasks: {
      pendingTasks: vi.fn().mockResolvedValue([]),
      recentTasks: vi.fn().mockResolvedValue([]),
      ledgerStatuses: vi.fn().mockResolvedValue([]),
      submit: vi.fn(),
      submitInit: vi.fn(),
      cancel: vi.fn(),
      retry: vi.fn(),
    },
    vector: {
      listTasks: vi
        .fn()
        .mockResolvedValue({ items: [], total: 0, running: 0, queued: 0, blocked: 0 }),
      cancel: vi.fn(),
      cancelMany: vi.fn(),
      retry: vi.fn(),
    },
    chatConfig: {
      readCleaningSelection: vi.fn(),
      writeCleaningSelection: vi.fn(),
      readAgentPresetOverride: vi.fn(),
      writeAgentPresetOverride: vi.fn(),
    },
    assertContext: vi.fn(),
    messageCount: vi.fn(() => 10),
  };
  const workspace = new TasksWorkspace(services);
  workspace.setContext(a);
  return { services, workspace };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("TasksWorkspace", () => {
  it("keeps the submission busy across A to B to A and clears its draft on success", async () => {
    const { services, workspace } = setup();
    let finish!: () => void;
    vi.mocked(services.tasks.submitInit).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return undefined as never;
    });
    workspace.setDraft("A draft");
    const submitting = workspace.submitInit();
    workspace.setContext(b);
    expect(workspace.getSnapshot().busy).toBe(false);
    workspace.setContext(a);
    expect(workspace.getSnapshot()).toMatchObject({ busy: true, draft: "A draft" });
    await workspace.submitInit();
    expect(services.tasks.submitInit).toHaveBeenCalledTimes(1);
    finish();
    await submitting;
    expect(workspace.getSnapshot()).toMatchObject({
      busy: false,
      draft: "",
      notice: "初始化任务已加入队列",
    });
    expect(workspace.hasUnsavedChanges()).toBe(false);
  });
  it("finishes A without changing B's draft or independent pending submission", async () => {
    const { services, workspace } = setup();
    let finishA!: () => void;
    let failB!: (error: Error) => void;
    vi.mocked(services.tasks.submitInit)
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finishA = resolve;
        });
        return undefined as never;
      })
      .mockImplementationOnce(async () => {
        await new Promise<void>((_, reject) => {
          failB = reject;
        });
        return undefined as never;
      });
    workspace.setDraft("A draft");
    const submittingA = workspace.submitInit();
    workspace.setContext(b);
    workspace.setDraft("B draft");
    const submittingB = workspace.submitInit();
    finishA();
    await submittingA;
    expect(workspace.getSnapshot()).toMatchObject({ busy: true, draft: "B draft", notice: null });
    workspace.setContext(a);
    expect(workspace.getSnapshot()).toMatchObject({ busy: false, draft: "" });
    workspace.setContext(b);
    failB(new Error("B failed"));
    await submittingB;
    expect(workspace.getSnapshot()).toMatchObject({
      busy: false,
      draft: "B draft",
      error: "B failed",
    });
    await workspace.submitInit();
    expect(services.tasks.submitInit).toHaveBeenCalledTimes(3);
  });
  it("waits for every read to settle after a failure before another refresh", async () => {
    const { services, workspace } = setup();
    let finish!: (value: Awaited<ReturnType<TasksServices["vector"]["listTasks"]>>) => void;
    vi.mocked(services.tasks.pendingTasks).mockRejectedValueOnce(new Error("read failed"));
    vi.mocked(services.vector.listTasks).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = workspace.refresh();
    await Promise.resolve();
    workspace.refresh();
    await Promise.resolve();
    expect(services.vector.listTasks).toHaveBeenCalledTimes(1);
    finish({ items: [], total: 0, running: 0, queued: 0, blocked: 0 });
    await first;
    expect(services.vector.listTasks).toHaveBeenCalledTimes(2);
    expect(workspace.getSnapshot().loadError).toBeNull();
  });
  it("retains conversation drafts and rejects submissions against changed host identity", async () => {
    const { services, workspace } = setup();
    workspace.setDraft("A draft");
    workspace.setContext(b);
    workspace.setDraft("B draft");
    workspace.setContext(a);
    expect(workspace.getSnapshot().draft).toBe("A draft");
    vi.mocked(services.assertContext).mockImplementation(() => {
      throw new Error("对话已变化");
    });
    await workspace.submitInit();
    expect(services.tasks.submitInit).not.toHaveBeenCalled();
    expect(workspace.getSnapshot().error).toBe("对话已变化");
    expect(workspace.getSnapshot().draft).toBe("A draft");
  });
  it("serializes refreshes and ignores old success across A to B to A", async () => {
    const { services, workspace } = setup();
    let resolve!: (value: Awaited<ReturnType<TasksServices["vector"]["listTasks"]>>) => void;
    vi.mocked(services.vector.listTasks).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = workspace.refresh();
    workspace.setContext(b);
    workspace.setContext(a);
    const second = workspace.refresh();
    expect(services.vector.listTasks).toHaveBeenCalledTimes(1);
    resolve({ items: [], total: 99, queued: 0, running: 0, blocked: 0 });
    await Promise.all([first, second]);
    expect(services.vector.listTasks).toHaveBeenCalledTimes(2);
    expect(workspace.getSnapshot().vectorTotal).toBe(0);
  });
  it("does not publish errors or completion notices into another conversation", async () => {
    const { services, workspace } = setup();
    let reject!: (error: Error) => void;
    vi.mocked(services.tasks.submitInit).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    workspace.setDraft("A draft");
    const submitting = workspace.submitInit();
    workspace.setContext(b);
    workspace.setDraft("B draft");
    reject(new Error("A failed"));
    await submitting;
    expect(workspace.getSnapshot()).toMatchObject({
      error: null,
      busy: false,
      draft: "B draft",
      notice: null,
    });
    workspace.setContext(a);
    expect(workspace.getSnapshot().draft).toBe("A draft");
  });
  it("validates range before enqueue and returns the error to the confirmation dialog", async () => {
    const { services, workspace } = setup();
    const invalid = await workspace.submitFloors("0", "10", "20");
    expect(invalid).toEqual({ ok: false, error: expect.stringContaining("超出范围") });
    expect(services.tasks.submit).not.toHaveBeenCalled();
    await workspace.refresh();
    expect(workspace.getSnapshot().error).toBeNull();
    await expect(workspace.submitFloors("0", "9", "2")).resolves.toEqual({
      ok: true,
      error: null,
    });
    expect(services.tasks.submit).toHaveBeenCalledWith({
      memorySpaceId: a.spaceId,
      from: 0,
      to: 9,
      blockSize: 2,
    });
  });
  it("writes chat config only for the current context and surfaces write failures", () => {
    const { services, workspace } = setup();
    workspace.updateCleaningSelection("rule-1");
    workspace.updateAgentPresetOverride("preset-1");
    expect(services.chatConfig.writeCleaningSelection).toHaveBeenCalledWith("rule-1");
    expect(services.chatConfig.writeAgentPresetOverride).toHaveBeenCalledWith("preset-1");
    expect(workspace.getSnapshot()).toMatchObject({
      cleaningSelection: undefined,
      agentPresetOverride: undefined,
      configNotice: "当前对话的 Agent 预设已保存",
    });
    vi.mocked(services.assertContext).mockImplementationOnce(() => {
      throw new Error("对话已变化");
    });
    workspace.updateCleaningSelection("rule-2");
    expect(services.chatConfig.writeCleaningSelection).not.toHaveBeenCalledWith("rule-2");
    expect(workspace.getSnapshot()).toMatchObject({
      configError: "对话已变化",
      configNotice: null,
    });
  });
  it("stops hidden and unmounted polling without cancelling background tasks", async () => {
    vi.useFakeTimers();
    const doc = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal("document", doc);
    const { services, workspace } = setup();
    const stop = workspace.startPolling();
    await workspace.refresh();
    const calls = vi.mocked(services.vector.listTasks).mock.calls.length;
    doc.hidden = true;
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(services.vector.listTasks).toHaveBeenCalledTimes(calls);
    doc.hidden = false;
    doc.dispatchEvent(new Event("visibilitychange"));
    await workspace.refresh();
    stop();
    const afterStop = vi.mocked(services.vector.listTasks).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(services.vector.listTasks).toHaveBeenCalledTimes(afterStop);
    expect(services.tasks.cancel).not.toHaveBeenCalled();
    expect(services.vector.cancelMany).not.toHaveBeenCalled();
  });
});
