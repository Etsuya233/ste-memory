import type { MemorySpaceId } from "../memory/index.ts";
import type { FillTaskService } from "./fill-task-service.ts";
import type { FillTask, FillTaskView } from "./fill-task.ts";
import {
  autoFillRange,
  migrateAutoFillSettings,
  validateAutoFillSettings,
  type AutoFillChatStore,
  type AutoFillSettings,
  type PendingFillContinuation,
} from "./auto-fill-settings.ts";

export interface AutoFillNotification {
  readonly kind: "reminder" | "started" | "completed" | "failed";
  readonly message: string;
  readonly identity: string;
}

interface AutoFillPorts {
  readonly tasks: Pick<
    FillTaskService,
    | "submit"
    | "activeTask"
    | "recentTasks"
    | "pendingTasks"
    | "ledgerStatuses"
    | "cancel"
    | "retry"
    | "suspend"
    | "kick"
  >;
  readonly chatStore: AutoFillChatStore;
  readonly globalSettings: () => AutoFillSettings;
  readonly current: () =>
    | {
        identity: string;
        chatId: string | undefined;
        spaceId: MemorySpaceId;
        chatLength: number;
        aiFloor: number;
      }
    | undefined;
  readonly notify: (notice: AutoFillNotification) => void;
  readonly confirmResume: (task: PendingFillContinuation) => Promise<boolean>;
  readonly dismissReminder: () => void;
  readonly reportError: (error: unknown) => void;
  readonly hideFloors: (identity: string, to: number) => Promise<void>;
}

/** 自动填表负责范围、入队和成功后的楼层隐藏；任务执行由 FillTaskService 管理。 */
export class AutoFillService {
  readonly #ports: AutoFillPorts;
  #checking = false;
  #pending = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #suspended = false;
  #epoch = 0;
  #reminded: string | undefined;
  #promptedResume: string | undefined;
  #observed = new Map<string, FillTaskView>();

  constructor(ports: AutoFillPorts) {
    this.#ports = ports;
  }

  start(): void {
    this.#timer = setInterval(() => this.kick(), 1000);
    this.kick();
  }
  stop(): void {
    clearInterval(this.#timer);
  }
  read() {
    return this.#ports.chatStore.read();
  }
  settings(): AutoFillSettings {
    return { ...this.#ports.globalSettings(), ...this.read().overrides };
  }

  async taskSucceeded(task: FillTask): Promise<void> {
    const current = this.#ports.current();
    if (
      !task.automatic ||
      task.kind !== "floor" ||
      task.status !== "succeeded" ||
      !current ||
      current.spaceId !== task.memorySpaceId ||
      current.chatId !== task.chatId ||
      this.#suspended
    )
      return;
    const settings = this.settings();
    if (settings.mode !== "auto" || !settings.hideAfterSuccess) return;
    const epoch = this.#epoch;
    try {
      const ledger = await this.#ports.tasks.ledgerStatuses(
        current.spaceId,
        0,
        current.chatLength - 1,
      );
      const latest = this.#ports.current();
      if (
        this.#epoch !== epoch ||
        this.#suspended ||
        latest?.identity !== current.identity ||
        latest.spaceId !== current.spaceId
      )
        return;
      const activeSettings = this.settings();
      if (activeSettings.mode !== "auto" || !activeSettings.hideAfterSuccess) return;
      const highest = ledger.reduce(
        (max, entry) => (entry.status === "processed" ? Math.max(max, entry.floor) : max),
        -1,
      );
      const to = Math.min(latest.chatLength - 1 - activeSettings.keepRecentFloors, highest);
      if (to >= 0) await this.#ports.hideFloors(current.identity, to);
    } catch (error) {
      this.#ports.reportError(error);
      if (this.#epoch !== epoch || this.#ports.current()?.identity !== current.identity) return;
      this.#observed.delete(task.runId);
      this.#ports.notify({
        kind: "failed",
        identity: current.identity,
        message: `自动填表已成功，隐藏楼层失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  saveOverrides(overrides: Partial<AutoFillSettings>): void {
    validateAutoFillSettings({ ...this.#ports.globalSettings(), ...overrides });
    this.#ports.chatStore.write({ ...this.read(), overrides });
    this.kick();
  }

  async range() {
    const current = this.#ports.current();
    if (!current || current.aiFloor < 0) return undefined;
    const ledger = await this.#ports.tasks.ledgerStatuses(
      current.spaceId,
      0,
      current.chatLength - 1,
    );
    if (this.#ports.current()?.identity !== current.identity) return undefined;
    return autoFillRange(ledger, current.aiFloor, this.settings().delayFloors);
  }

  generationStarted(): void {
    this.#suspended = true;
    this.#ports.tasks.suspend();
  }
  generationEnded(): void {
    this.#suspended = false;
    this.kick();
  }

  async chatChanged(): Promise<void> {
    this.#suspended = true;
    this.#epoch += 1;
    this.#ports.tasks.suspend();
    this.#reminded = undefined;
    this.#promptedResume = undefined;
    this.#observed.clear();
    const current = this.#ports.current();
    if (!current) return;
    const active = await this.#ports.tasks.activeTask(current.spaceId);
    if (active) await this.#ports.tasks.cancel(current.spaceId, active.runId, "chat-changed");
  }
  chatReady(): void {
    this.#suspended = false;
    this.kick();
  }

  kick(): void {
    this.#pending = true;
    if (this.#checking) return;
    this.#checking = true;
    void (async () => {
      try {
        while (this.#pending) {
          this.#pending = false;
          await this.#check();
        }
      } catch (error) {
        this.#ports.reportError(error);
      } finally {
        this.#checking = false;
      }
    })();
  }

  async #check(): Promise<void> {
    const current = this.#ports.current();
    if (!current || this.#suspended) return;
    const epoch = this.#epoch;
    const unchanged = () =>
      this.#epoch === epoch &&
      !this.#suspended &&
      this.#ports.current()?.identity === current.identity;
    const settings = this.settings();
    let pending = await this.#ports.tasks.pendingTasks(current.spaceId);
    if (!unchanged()) return;

    // 旧版本的聊天暂存项只在升级时转入任务表，之后删除旧状态。
    const legacy = this.read();
    if (settings.mode === "auto" && (legacy.stagedTasks?.length || legacy.inFlightTask)) {
      this.#ports.tasks.suspend();
      const items = [
        ...(legacy.inFlightTask ? [legacy.inFlightTask] : []),
        ...(legacy.stagedTasks ?? []),
      ];
      const ledger = await this.#ports.tasks.ledgerStatuses(
        current.spaceId,
        0,
        current.chatLength - 1,
      );
      const remaining = autoFillRange(ledger, current.chatLength - 1, 0);
      if (!unchanged()) return;
      for (const item of items) {
        if (!unchanged()) return;
        const from = Math.max(item.from, remaining?.from ?? current.chatLength);
        const to = Math.min(item.to, current.chatLength - 1);
        if (from > to) continue;
        if (pending.some((task) => task.kind === "floor" && task.from <= from && task.to >= to))
          continue;
        const task = await this.#submit(current, from, to, {
          ...settings,
          ...migrateAutoFillSettings(item.settings),
        });
        if (item === items[0] && (legacy.pausedReason || legacy.pendingResumeTask))
          await this.#ports.tasks.cancel(current.spaceId, task.runId, "chat-changed");
      }
      if (!unchanged()) return;
      this.#ports.chatStore.write({
        overrides: legacy.overrides,
        pausedReason: null,
        lastScheduled: legacy.lastScheduled,
      });
      pending = await this.#ports.tasks.pendingTasks(current.spaceId);
      if (!unchanged()) return;
    }

    if (settings.mode !== "auto") {
      for (const task of pending.filter((task) => task.automatic)) {
        if (!unchanged()) return;
        await this.#ports.tasks.cancel(current.spaceId, task.runId);
      }
      pending = pending.filter((task) => !task.automatic);
    }
    if (!unchanged()) return;
    const recent = await this.#ports.tasks.recentTasks(current.spaceId, 20);
    if (!unchanged()) return;
    for (const [runId, task] of this.#observed) {
      if (pending.some((item) => item.runId === runId && item.status !== "failed")) continue;
      const finished = recent.find((item) => item.runId === runId);
      if (finished?.status === "failed" || finished?.status === "succeeded")
        this.#ports.notify({
          kind: finished.status === "failed" ? "failed" : "completed",
          identity: current.identity,
          message: `自动填表 #${task.from}–#${task.to} ${finished.status === "failed" ? `停止：${finished.errorMessage}` : "已完成"}`,
        });
      this.#observed.delete(runId);
    }
    const head = pending[0];
    if (
      head?.automatic &&
      head.blocksQueue &&
      head.interruptionReason === "chat-changed" &&
      this.#promptedResume !== `${current.identity}:${head.runId}`
    ) {
      this.#promptedResume = `${current.identity}:${head.runId}`;
      const confirmed = await this.#ports.confirmResume(head);
      if (!unchanged()) return;
      if (confirmed) await this.#ports.tasks.retry(current.spaceId, head.runId);
    }
    if (!unchanged()) return;
    const range = await this.range();
    if (!unchanged()) return;
    if (settings.mode !== "remind") {
      this.#ports.dismissReminder();
      this.#reminded = undefined;
    }
    if (settings.mode === "remind" && range && range.to - range.from + 1 >= settings.interval) {
      const key = `${current.identity}:${range.from}:${range.to}`;
      if (this.#reminded !== key) {
        this.#reminded = key;
        this.#ports.notify({
          kind: "reminder",
          identity: current.identity,
          message: `待填 #${range.from}–#${range.to}，共 ${range.to - range.from + 1} 层`,
        });
      }
    } else if (settings.mode === "remind") {
      this.#ports.dismissReminder();
      this.#reminded = undefined;
    }
    if (settings.mode === "auto" && range) {
      const reservedThrough = pending.reduce(
        (highest, task) => (task.kind === "floor" ? Math.max(highest, task.to) : highest),
        -1,
      );
      const from = Math.max(range.from, reservedThrough + 1);
      const state = this.read();
      if (
        range.to - from + 1 >= settings.interval &&
        (state.lastScheduled?.memorySpaceId !== current.spaceId ||
          state.lastScheduled.to !== range.to)
      ) {
        try {
          await this.#submit(current, from, range.to, settings);
          if (!unchanged()) return;
          this.#ports.chatStore.write({
            ...this.read(),
            pausedReason: null,
            lastScheduled: { memorySpaceId: current.spaceId, to: range.to },
          });
        } catch (error) {
          if (unchanged())
            this.#ports.notify({
              kind: "failed",
              identity: current.identity,
              message: `自动填表入队失败：${error instanceof Error ? error.message : String(error)}`,
            });
          return;
        }
      }
    }
    if (unchanged()) this.#ports.tasks.kick(current.spaceId);
  }

  async #submit(
    current: NonNullable<ReturnType<AutoFillPorts["current"]>>,
    from: number,
    to: number,
    settings: AutoFillSettings,
  ): Promise<FillTaskView> {
    validateAutoFillSettings(settings);
    const task = await this.#ports.tasks.submit({
      memorySpaceId: current.spaceId,
      from,
      to,
      blockSize: settings.blockSize,
      automatic: {
        retries: settings.retries,
        delaySeconds: settings.retryDelaySeconds,
        interruptionReason: () =>
          this.#ports.current()?.identity !== current.identity ? "chat-changed" : undefined,
        canContinue: () =>
          this.#ports.current()?.identity === current.identity &&
          this.settings().mode === settings.mode,
      },
    });
    this.#observed.set(task.runId, task);
    this.#ports.notify({
      kind: "started",
      identity: current.identity,
      message: `已加入填表队列 #${from}–#${to}，每批 ${settings.blockSize} 层`,
    });
    return task;
  }
}
