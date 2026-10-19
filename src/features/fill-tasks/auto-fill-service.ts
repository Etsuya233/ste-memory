import type { MemorySpaceId } from "../memory/index.ts";
import type { FillTaskService } from "./fill-task-service.ts";
import { FillTaskConflictError, type FillTaskView } from "./fill-task.ts";
import {
  autoFillRange,
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
    "submit" | "activeTask" | "recentTasks" | "ledgerStatuses" | "cancel"
  >;
  readonly chatStore: AutoFillChatStore;
  readonly globalSettings: () => AutoFillSettings;
  readonly current: () =>
    { identity: string; spaceId: MemorySpaceId; chatLength: number; aiFloor: number } | undefined;
  readonly notify: (notice: AutoFillNotification) => void;
  readonly confirmResume: (task: PendingFillContinuation) => Promise<boolean>;
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
  #resumeChecked = false;
  #promptedResume: string | undefined;

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

  async resume(): Promise<void> {
    const state = this.read();
    const task = state.pendingResumeTask ?? state.pausedTask;
    if (task) {
      await this.retry(task);
      return;
    }
    this.#ports.chatStore.write({ ...state, pausedReason: null });
    this.kick();
  }

  async cancel(): Promise<void> {
    const current = this.#ports.current();
    if (!current) return;
    const active = await this.#ports.tasks.activeTask(current.spaceId);
    if (this.#ports.current()?.identity !== current.identity) throw new Error("对话已切换");
    if (!active?.automatic) throw new Error("当前没有正在执行的自动填表任务");
    this.#job = undefined;
    await this.#ports.tasks.cancel(current.spaceId, active.runId);
    if (this.#ports.current()?.identity !== current.identity) return;
    this.#ports.chatStore.write({
      ...this.read(),
      pausedReason: null,
      pausedTask: undefined,
      pendingResumeTask: undefined,
      inFlightTask: undefined,
      acknowledgedInterruptionRunId: active.runId,
      lastScheduled: {
        memorySpaceId: current.spaceId,
        to: current.aiFloor - (this.settings().includeCurrent ? 0 : 1),
      },
    });
    this.kick();
  }

  async cancelPausedTask(): Promise<void> {
    const current = this.#ports.current();
    if (!current) throw new Error("当前对话未就绪");
    const state = this.read();
    if (!state.pausedReason) throw new Error("当前没有暂停的填表任务");
    const task = state.pendingResumeTask ?? state.pausedTask ?? this.#job?.task;
    const active = await this.#ports.tasks.activeTask(current.spaceId);
    if (this.#ports.current()?.identity !== current.identity) throw new Error("对话已切换");
    if (active?.automatic && active.runId === task?.runId)
      await this.#ports.tasks.cancel(current.spaceId, active.runId);
    if (this.#ports.current()?.identity !== current.identity) return;
    const latest = this.read();
    this.#job = undefined;
    this.#ports.chatStore.write({
      ...latest,
      pausedReason: null,
      pausedTask: undefined,
      pendingResumeTask: undefined,
      inFlightTask: undefined,
      acknowledgedInterruptionRunId:
        state.pendingResumeTask?.runId ?? latest.acknowledgedInterruptionRunId,
      lastScheduled: {
        memorySpaceId: current.spaceId,
        to: current.aiFloor - (this.settings().includeCurrent ? 0 : 1),
      },
      stagedTasks: task
        ? latest.stagedTasks?.filter(
            (item) =>
              item.memorySpaceId !== task.memorySpaceId ||
              item.to !== task.to ||
              item.from > task.from,
          )
        : latest.stagedTasks?.slice(1),
    });
    this.kick();
  }

  async retry(task: PendingFillContinuation): Promise<boolean> {
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
    const state = this.read();
    const pending = state.pendingResumeTask ?? state.pausedTask;
    if (pending?.runId === task.runId)
      this.#ports.chatStore.write({
        ...this.read(),
        pausedReason: null,
        pendingResumeTask: undefined,
        pausedTask: undefined,
        stagedTasks: state.stagedTasks?.filter(
          (item) =>
            item.memorySpaceId !== task.memorySpaceId ||
            item.to !== task.to ||
            item.from > task.from,
        ),
      });
    try {
      if (from <= to)
        await this.#submit(current, from, to, { ...this.settings(), blockSize: task.blockSize });
    } catch (error) {
      if (pending?.runId === task.runId && this.#ports.current()?.identity === current.identity)
        this.#ports.chatStore.write({
          ...this.read(),
          pausedReason: error instanceof Error ? error.message : String(error),
          pendingResumeTask: state.pendingResumeTask,
          pausedTask: state.pausedTask,
        });
      throw error;
    }
    if (this.#ports.current()?.identity !== current.identity) return false;
    this.kick();
    return from <= to;
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
    this.#resumeChecked = false;
    this.#promptedResume = undefined;
    if (job) {
      const active = await this.#ports.tasks.activeTask(job.task.memorySpaceId);
      if (active?.runId === job.task.runId)
        await this.#ports.tasks.cancel(active.memorySpaceId, active.runId, "chat-changed");
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
      this.#resumeChecked = false;
      this.#promptedResume = undefined;
    }
    const epoch = this.#epoch;
    const settings = this.settings();
    if (settings.mode !== "remind") {
      this.#ports.dismissReminder();
      this.#reminded = undefined;
    }
    if (
      settings.mode === "off" &&
      !this.#job &&
      this.#resumeChecked &&
      !this.read().pendingResumeTask
    )
      return;
    const active = await this.#ports.tasks.activeTask(current.spaceId);
    if (this.#ports.current()?.identity !== current.identity) return;
    if (!this.#suspended && !active && !this.#resumeChecked) {
      const recent = await this.#ports.tasks.recentTasks(current.spaceId, 1);
      if (this.#ports.current()?.identity !== current.identity || this.#epoch !== epoch) return;
      this.#resumeChecked = true;
      const interrupted = recent[0];
      if (
        interrupted?.automatic &&
        interrupted.status === "interrupted" &&
        interrupted.interruptionReason === "chat-changed" &&
        interrupted.runId !== this.read().acknowledgedInterruptionRunId
      ) {
        const { runId, memorySpaceId, from, to, blockSize } = interrupted;
        this.#ports.chatStore.write({
          ...this.read(),
          pausedReason: "切换对话后填表任务已中断，是否继续填表？",
          acknowledgedInterruptionRunId: runId,
          pendingResumeTask: { runId, memorySpaceId, from, to, blockSize },
        });
      }
    }
    if (this.#job?.identity === current.identity) {
      if (settings.mode !== this.#job.mode) {
        const job = this.#job;
        this.#job = undefined;
        if (active?.runId === job.task.runId)
          await this.#ports.tasks.cancel(active.memorySpaceId, active.runId);
        return;
      }
      if (active?.runId !== this.#job.task.runId) {
        const job = this.#job;
        this.#job = undefined;
        const recent = await this.#ports.tasks.recentTasks(current.spaceId, 20);
        if (this.#ports.current()?.identity !== current.identity) return;
        const finished = recent.find((task) => task.runId === job.task.runId);
        if (finished?.status === "failed" || finished?.status === "interrupted") {
          const reason = finished.errorMessage ?? "自动填表已中断";
          const { runId, memorySpaceId, from, to, blockSize } = job.task;
          this.#ports.chatStore.write({
            ...this.read(),
            pausedReason: reason,
            pausedTask: { runId, memorySpaceId, from, to, blockSize },
          });
          this.#ports.notify({
            kind: "failed",
            identity: current.identity,
            message: `自动填表 #${job.task.from}–#${job.task.to} 停止：${reason}`,
          });
        }
        if (finished?.status === "succeeded") {
          this.#ports.chatStore.write({ ...this.read(), inFlightTask: undefined });
          this.#ports.notify({
            kind: "completed",
            identity: current.identity,
            message: `自动填表 #${job.task.from}–#${job.task.to} 已完成`,
          });
        }
      }
    }
    if (this.#suspended) return;
    const saved = this.read();
    if (
      !active &&
      !this.#job &&
      !saved.pausedReason &&
      !saved.pendingResumeTask &&
      saved.inFlightTask
    ) {
      this.#ports.chatStore.write({
        ...saved,
        inFlightTask: undefined,
        stagedTasks: [saved.inFlightTask, ...(saved.stagedTasks ?? [])],
      });
    }
    const range = await this.range();
    if (
      this.#ports.current()?.identity !== current.identity ||
      this.#suspended ||
      this.#epoch !== epoch
    )
      return;
    if (settings.mode === "auto" && range) {
      const state = this.read();
      const reserved = [
        active?.kind === "floor" ? active : undefined,
        this.#job?.task,
        state.pendingResumeTask,
        state.pausedTask,
        state.inFlightTask,
        ...(state.stagedTasks ?? []),
      ];
      const reservedThrough = reserved.reduce(
        (highest, task) =>
          task?.memorySpaceId === current.spaceId ? Math.max(highest, task.to) : highest,
        -1,
      );
      const from = Math.max(range.from, reservedThrough + 1);
      if (
        range.to - from + 1 >= settings.interval &&
        (state.lastScheduled?.memorySpaceId !== current.spaceId ||
          state.lastScheduled.to !== range.to)
      ) {
        this.#ports.chatStore.write({
          ...state,
          stagedTasks: [
            ...(state.stagedTasks ?? []),
            { memorySpaceId: current.spaceId, from, to: range.to, settings: { ...settings } },
          ],
          lastScheduled: { memorySpaceId: current.spaceId, to: range.to },
        });
      }
    }
    const pendingResumeTask = this.read().pendingResumeTask;
    if (pendingResumeTask) {
      const promptKey = `${current.identity}:${pendingResumeTask.runId}`;
      if (!this.#suspended && !active && this.#promptedResume !== promptKey) {
        this.#promptedResume = promptKey;
        const confirmed = await this.#ports.confirmResume(pendingResumeTask);
        if (this.#ports.current()?.identity !== current.identity || this.#epoch !== epoch) return;
        if (confirmed) {
          try {
            await this.resume();
          } catch (error) {
            if (this.#ports.current()?.identity === current.identity && this.#epoch === epoch)
              this.#ports.notify({
                kind: "failed",
                identity: current.identity,
                message: `继续填表失败：${error instanceof Error ? error.message : String(error)}`,
              });
          }
        }
      }
      return;
    }
    if (active || settings.mode === "off" || this.read().pausedReason) return;
    if (settings.mode === "remind") {
      if (!range || range.to - range.from + 1 < settings.interval) {
        this.#ports.dismissReminder();
        this.#reminded = undefined;
        return;
      }
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
    const staged = this.read().stagedTasks?.[0];
    if (!staged) return;
    if (staged.memorySpaceId !== current.spaceId)
      throw new Error("暂存任务所属记忆空间已变化，请先处理该任务");
    const from = Math.max(staged.from, range?.from ?? current.chatLength);
    if (from > staged.to) {
      this.#ports.chatStore.write({
        ...this.read(),
        stagedTasks: this.read().stagedTasks!.slice(1),
      });
      this.kick();
      return;
    }
    try {
      await this.#submit(current, from, staged.to, staged.settings);
      if (this.#ports.current()?.identity !== current.identity || this.#epoch !== epoch) return;
      this.#ports.chatStore.write({
        ...this.read(),
        stagedTasks: this.read().stagedTasks?.filter(
          (item) =>
            item.memorySpaceId !== staged.memorySpaceId ||
            item.from !== staged.from ||
            item.to !== staged.to,
        ),
      });
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
        interruptionReason: () =>
          this.#epoch !== epoch || this.#ports.current()?.identity !== current.identity
            ? "chat-changed"
            : undefined,
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
      await this.#ports.tasks.cancel(task.memorySpaceId, task.runId, "chat-changed");
      return;
    }
    this.#ports.chatStore.write({
      ...this.read(),
      inFlightTask: { memorySpaceId: current.spaceId, from, to, settings: { ...settings } },
    });
    this.#job = { identity: current.identity, task, mode: settings.mode };
    this.#ports.notify({
      kind: "started",
      identity: current.identity,
      message: `开始填表 #${from}–#${to}，每批 ${settings.blockSize} 层`,
    });
  }
}
