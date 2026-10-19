import type { MemorySpaceId } from "../memory/index.ts";
import type { FillTaskService } from "./fill-task-service.ts";
import { FillTaskConflictError, type FillTaskView } from "./fill-task.ts";
import {
  autoFillRange,
  validateAutoFillSettings,
  type AutoFillChatStore,
  type AutoFillSettings,
} from "./auto-fill-settings.ts";

export interface AutoFillNotification {
  readonly kind: "reminder" | "started" | "completed" | "failed";
  readonly message: string;
  readonly identity: string;
}

interface AutoFillPorts {
  readonly tasks: Pick<
    FillTaskService,
    "submit" | "activeTask" | "recentTasks" | "ledgerStatuses" | "cancel"
  >;
  readonly chatStore: AutoFillChatStore;
  readonly globalSettings: () => AutoFillSettings;
  readonly current: () =>
    { identity: string; spaceId: MemorySpaceId; chatLength: number; aiFloor: number } | undefined;
  readonly notify: (notice: AutoFillNotification) => void;
  readonly dismissReminder: () => void;
  readonly reportError: (error: unknown) => void;
}

/** 调度只管理当前聊天；重试由同一个填表任务在批内执行。 */
export class AutoFillService {
  readonly #ports: AutoFillPorts;
  #checking = false;
  #pending = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #job: { identity: string; task: FillTaskView; mode: AutoFillSettings["mode"] } | undefined;
  #reminded: string | undefined;
  #identity: string | undefined;
  #suspended = false;
  #epoch = 0;

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

  saveOverrides(overrides: Partial<AutoFillSettings>): void {
    validateAutoFillSettings({ ...this.#ports.globalSettings(), ...overrides });
    this.#ports.chatStore.write({ ...this.read(), overrides });
    this.kick();
  }

  resume(): void {
    this.#ports.chatStore.write({ ...this.read(), pausedReason: null });
    this.kick();
  }

  async cancel(): Promise<void> {
    const current = this.#ports.current();
    if (!current) return;
    this.#ports.chatStore.write({ ...this.read(), pausedReason: "用户已取消自动填表" });
    const active = await this.#ports.tasks.activeTask(current.spaceId);
    if (active?.automatic) await this.#ports.tasks.cancel(current.spaceId, active.runId);
  }

  async retry(task: FillTaskView): Promise<void> {
    const current = this.#ports.current();
    if (!current || current.spaceId !== task.memorySpaceId)
      throw new Error("请回到任务所属对话后重试");
    const ledger = await this.#ports.tasks.ledgerStatuses(
      current.spaceId,
      0,
      current.chatLength - 1,
    );
    if (this.#ports.current()?.identity !== current.identity) throw new Error("对话已切换");
    const range = autoFillRange(ledger, current.chatLength - 1, true);
    const from = Math.max(task.from, range?.from ?? current.chatLength);
    const to = Math.min(task.to, current.chatLength - 1);
    if (from > to) throw new Error("此任务已无需重试");
    await this.#submit(current, from, to, { ...this.settings(), blockSize: task.blockSize });
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
    return autoFillRange(ledger, current.aiFloor, this.settings().includeCurrent);
  }

  /** 生成开始后暂停检查，完整回复结束后重新开放，避免流式消息进入范围。 */
  generationStarted(): void {
    this.#suspended = true;
  }
  generationEnded(): void {
    this.#suspended = false;
    this.kick();
  }

  async chatChanged(): Promise<void> {
    this.#suspended = true;
    this.#epoch += 1;
    const job = this.#job;
    this.#job = undefined;
    this.#reminded = undefined;
    if (job) {
      const active = await this.#ports.tasks.activeTask(job.task.memorySpaceId);
      if (active?.runId === job.task.runId)
        await this.#ports.tasks.cancel(active.memorySpaceId, active.runId);
    }
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
    if (!current) {
      this.#ports.dismissReminder();
      const job = this.#job;
      this.#job = undefined;
      if (job) {
        const active = await this.#ports.tasks.activeTask(job.task.memorySpaceId);
        if (active?.runId === job.task.runId)
          await this.#ports.tasks.cancel(active.memorySpaceId, active.runId);
      }
      return;
    }
    if (current.identity !== this.#identity) {
      this.#identity = current.identity;
      this.#reminded = undefined;
    }
    const epoch = this.#epoch;
    const settings = this.settings();
    if (settings.mode !== "remind") {
      this.#ports.dismissReminder();
      this.#reminded = undefined;
    }
    if (settings.mode === "off" && !this.#job) return;
    const active = await this.#ports.tasks.activeTask(current.spaceId);
    if (this.#ports.current()?.identity !== current.identity) return;
    if (this.#job?.identity === current.identity) {
      if (settings.mode !== this.#job.mode) {
        const job = this.#job;
        this.#job = undefined;
        if (active?.runId === job.task.runId)
          await this.#ports.tasks.cancel(active.memorySpaceId, active.runId);
        return;
      }
      if (active?.runId === this.#job.task.runId) return;
      const job = this.#job;
      this.#job = undefined;
      const recent = await this.#ports.tasks.recentTasks(current.spaceId, 20);
      if (this.#ports.current()?.identity !== current.identity) return;
      const finished = recent.find((task) => task.runId === job.task.runId);
      if (finished?.status === "failed" || finished?.status === "interrupted") {
        const reason = finished.errorMessage ?? "自动填表已中断";
        this.#ports.chatStore.write({ ...this.read(), pausedReason: reason });
        this.#ports.notify({
          kind: "failed",
          identity: current.identity,
          message: `自动填表 #${job.task.from}–#${job.task.to} 停止：${reason}`,
        });
        return;
      }
      if (finished?.status === "succeeded")
        this.#ports.notify({
          kind: "completed",
          identity: current.identity,
          message: `自动填表 #${job.task.from}–#${job.task.to} 已完成`,
        });
    }
    if (
      this.#suspended ||
      active ||
      settings.mode === "off" ||
      (settings.mode === "auto" && this.read().pausedReason)
    )
      return;
    const range = await this.range();
    if (this.#ports.current()?.identity !== current.identity || this.#suspended) return;
    if (!range || range.to - range.from + 1 < settings.interval) {
      this.#ports.dismissReminder();
      this.#reminded = undefined;
      return;
    }
    if (settings.mode === "remind") {
      const key = `${current.identity}:${range.from}:${range.to}`;
      if (this.#reminded !== key) {
        this.#reminded = key;
        this.#ports.notify({
          kind: "reminder",
          identity: current.identity,
          message: `待填 #${range.from}–#${range.to}，共 ${range.to - range.from + 1} 层`,
        });
      }
      return;
    }
    try {
      await this.#submit(current, range.from, range.to, settings);
    } catch (error) {
      if (
        this.#epoch !== epoch ||
        this.settings().mode !== settings.mode ||
        error instanceof FillTaskConflictError ||
        this.#ports.current()?.identity !== current.identity
      )
        return;
      const reason = error instanceof Error ? error.message : String(error);
      this.#ports.chatStore.write({ ...this.read(), pausedReason: reason });
      this.#ports.notify({
        kind: "failed",
        identity: current.identity,
        message: `自动填表暂停：${reason}`,
      });
    }
  }

  async #submit(
    current: NonNullable<ReturnType<AutoFillPorts["current"]>>,
    from: number,
    to: number,
    settings: AutoFillSettings,
  ): Promise<void> {
    validateAutoFillSettings(settings);
    const epoch = this.#epoch;
    const task = await this.#ports.tasks.submit({
      memorySpaceId: current.spaceId,
      from,
      to,
      blockSize: settings.blockSize,
      automatic: {
        retries: settings.retries,
        delaySeconds: settings.retryDelaySeconds,
        canContinue: () => {
          const latest = this.#ports.current();
          return (
            this.#epoch === epoch &&
            latest?.identity === current.identity &&
            latest.spaceId === current.spaceId &&
            this.settings().mode === settings.mode
          );
        },
        onFailure: (message) => {
          if (
            this.#epoch === epoch &&
            this.#ports.current()?.identity === current.identity &&
            this.settings().mode === settings.mode
          )
            this.#ports.chatStore.write({ ...this.read(), pausedReason: message });
        },
      },
    });
    if (this.#ports.current()?.identity !== current.identity || this.#suspended) {
      await this.#ports.tasks.cancel(task.memorySpaceId, task.runId);
      return;
    }
    this.#job = { identity: current.identity, task, mode: settings.mode };
    this.#ports.notify({
      kind: "started",
      identity: current.identity,
      message: `开始填表 #${from}–#${to}，每批 ${settings.blockSize} 层`,
    });
  }
}
