import type { MemorySpaceBackup } from "../backup/index.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-manager.ts";
import { createChatMirrorFile, decodeChatMirrorFile } from "./chat-mirror-codec.ts";
import type { ChatMirrorFile } from "./chat-mirror-file.ts";

/** 保存任务捕获文件身份，离开聊天后也不能从活动聊天推导保存目标。 */
export type ChatFileTarget =
  | {
      readonly kind: "character";
      readonly identity: string;
      readonly chatId: string;
      readonly avatarUrl: string;
    }
  | { readonly kind: "group"; readonly identity: string; readonly chatId: string };

export interface ChatSnapshotFileStore {
  read(target: ChatFileTarget): Promise<unknown>;
  write(
    target: ChatFileTarget,
    file: ChatMirrorFile,
    binding: ChatSpaceBinding,
    operation: SnapshotSaveOperation,
  ): Promise<void>;
  /** 文件成功且任务仍为最新时，才发布到宿主活动页metadata。 */
  publish(target: ChatFileTarget, file: ChatMirrorFile, binding: ChatSpaceBinding): void;
}
export type SnapshotSaveOperation = "update" | "replacement";
export type ChatSnapshotSaveStatus =
  | { readonly kind: "idle" }
  | {
      readonly kind: "saving";
      readonly identity: string;
      readonly operation: SnapshotSaveOperation;
    }
  | {
      readonly kind: "saved";
      readonly identity: string;
      readonly lastWrittenAt: string;
      readonly sizeBytes: number;
    }
  | {
      readonly kind: "failed";
      readonly identity: string;
      readonly operation: SnapshotSaveOperation;
      readonly error: string;
      readonly humanMsg: string;
    };

const IDLE_STATUS: ChatSnapshotSaveStatus = { kind: "idle" };

export class ChatSnapshotReplacementSaveError extends Error {
  readonly humanMsg: string;
  constructor(cause: unknown, humanMsg: string) {
    super(humanMsg, { cause });
    this.name = "ChatSnapshotReplacementSaveError";
    this.humanMsg = this.message;
  }
}
interface SavedChatContent {
  readonly target: ChatFileTarget;
  readonly snapshot: MemorySpaceBackup;
  readonly binding: ChatSpaceBinding;
}
interface SaveWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

type SaveTask = (
  | {
      readonly operation: "update";
      readonly content: SavedChatContent;
      readonly file: ChatMirrorFile;
      stage: "write" | "complete";
      readonly savedBatches: readonly (() => Promise<void>)[];
    }
  | {
      readonly operation: "replacement";
      readonly content: SavedChatContent;
      readonly file: ChatMirrorFile;
      stage: "write" | "activate";
      readonly activate: () => Promise<void>;
    }
) & { readonly waiters: SaveWaiter[] };
interface ChatSaveEntry {
  current?: SavedChatContent;
  retained: boolean;
  pending?: SaveTask;
  status: ChatSnapshotSaveStatus;
  queue: Promise<void>;
}

/** 每个文件持有自己的当前内容与最新保存任务；SQLite卸载不影响这份运行中状态。 */
export class ChatSnapshotPersistence {
  readonly #entries = new Map<string, ChatSaveEntry>();
  readonly #listeners = new Set<() => void>();
  private readonly store: ChatSnapshotFileStore;
  private readonly appVersion: () => string;
  constructor(store: ChatSnapshotFileStore, appVersion: () => string) {
    this.store = store;
    this.appVersion = appVersion;
  }

  hasPendingWrites(): boolean {
    return [...this.#entries.values()].some((entry) => entry.pending !== undefined);
  }

  getStatus(identity?: string): ChatSnapshotSaveStatus {
    return identity === undefined
      ? IDLE_STATUS
      : (this.#entries.get(identity)?.status ?? IDLE_STATUS);
  }
  onStatusChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  remember(target: ChatFileTarget, snapshot: MemorySpaceBackup, binding: ChatSpaceBinding): void {
    this.entry(target.identity).retained = true;
    this.entry(target.identity).current = {
      target: { ...target },
      snapshot: structuredClone(snapshot),
      binding: { ...binding },
    };
  }
  current(identity: string): SavedChatContent | undefined {
    const entry = this.#entries.get(identity);
    const pending = entry?.pending;
    return pending?.operation === "replacement" && pending.stage === "activate"
      ? pending.content
      : entry?.current;
  }
  release(identity: string): void {
    const entry = this.#entries.get(identity);
    if (!entry) return;
    entry.retained = false;
    if (!entry.pending) entry.current = undefined;
  }
  hasSavedReplacement(identity: string): boolean {
    const task = this.#entries.get(identity)?.pending;
    return task?.operation === "replacement" && task.stage === "activate";
  }
  hasPendingReplacement(identity: string): boolean {
    return this.#entries.get(identity)?.pending?.operation === "replacement";
  }

  async load(target: ChatFileTarget, spaceId?: string): Promise<MemorySpaceBackup | undefined> {
    const entry = this.#entries.get(target.identity);
    // 返回未保存聊天时优先恢复已提交内存内容，磁盘可能仍是较早的快照。
    if (entry?.pending) return this.current(target.identity)?.snapshot;
    const raw = await this.store.read(target);
    if (this.#entries.get(target.identity)?.pending) return this.current(target.identity)?.snapshot;
    if (raw === undefined) return undefined;
    const file = decodeChatMirrorFile(raw);
    if (!file) throw new Error("对话文件中的记忆快照损坏或版本无法识别");
    if (spaceId !== undefined && file.spaceId !== spaceId)
      throw new Error("对话文件中的记忆快照与空间绑定不一致");
    return file.data;
  }

  saveCommitted(
    target: ChatFileTarget,
    binding: ChatSpaceBinding,
    snapshot: MemorySpaceBackup,
    saved?: () => Promise<void>,
  ): Promise<void> {
    return this.schedule({ target, snapshot, binding }, "update", saved);
  }
  replace(
    target: ChatFileTarget,
    snapshot: MemorySpaceBackup,
    binding: ChatSpaceBinding,
    activate: () => Promise<void>,
  ): Promise<void> {
    return this.schedule({ target, snapshot, binding }, "replacement", activate);
  }
  retry(identity: string): Promise<void> {
    const entry = this.#entries.get(identity);
    if (!entry?.pending) return Promise.resolve();
    return this.enqueue(entry, entry.pending);
  }
  private entry(identity: string): ChatSaveEntry {
    let entry = this.#entries.get(identity);
    if (!entry) {
      entry = { status: IDLE_STATUS, queue: Promise.resolve(), retained: true };
      this.#entries.set(identity, entry);
    }
    return entry;
  }
  private schedule(
    content: SavedChatContent,
    operation: SnapshotSaveOperation,
    afterWrite?: () => Promise<void>,
  ): Promise<void> {
    const captured = structuredClone(content);
    const file = createChatMirrorFile(
      captured.snapshot,
      captured.binding.spaceId,
      captured.snapshot.space.updatedAt,
      this.appVersion(),
    );
    const entry = this.entry(content.target.identity);
    const previous = entry.pending;
    const continuedUpdate = operation === "update" && previous?.operation === "update";
    // 尚在写文件的调用随最新快照结算，内部旧job退出不能提前完成业务Promise。
    const waiters = continuedUpdate && previous.stage === "write" ? previous.waiters.splice(0) : [];
    if (previous && !continuedUpdate) {
      const error = new Error("保存操作已被新的候选替代");
      for (const waiter of previous.waiters.splice(0)) waiter.reject(error);
    }
    const task: SaveTask =
      operation === "update"
        ? {
            content: captured,
            file,
            operation,
            stage: "write",
            waiters,
            savedBatches: [
              ...(entry.pending?.operation === "update" ? entry.pending.savedBatches : []),
              ...(afterWrite ? [afterWrite] : []),
            ],
          }
        : { content: captured, file, operation, activate: afterWrite!, stage: "write", waiters };
    if (operation === "update") entry.current = captured;
    entry.pending = task;
    const completion = this.enqueue(entry, task);
    this.setStatus(entry, { kind: "saving", identity: content.target.identity, operation });
    return completion;
  }
  private enqueue(entry: ChatSaveEntry, task: SaveTask): Promise<void> {
    const completion = new Promise<void>((resolve, reject) =>
      task.waiters.push({ resolve, reject }),
    );
    const run = entry.queue.then(() => this.writeLatest(entry, task));
    entry.queue = run.catch(() => undefined);
    return completion;
  }
  private async writeLatest(entry: ChatSaveEntry, task: SaveTask): Promise<void> {
    if (entry.pending !== task) return;
    const { target, binding } = task.content;
    this.setStatus(entry, { kind: "saving", identity: target.identity, operation: task.operation });
    try {
      if (task.stage === "write") {
        await this.store.write(target, task.file, binding, task.operation);
        if (task.operation === "replacement") task.stage = "activate";
        else task.stage = "complete";
      }
      if (entry.pending !== task) return;
      // 最新任务才可发布metadata；候选在文件成功后执行其明确的激活步骤。
      this.store.publish(target, task.file, binding);
      if (task.operation === "replacement") await task.activate();
      else for (const acknowledge of task.savedBatches) await acknowledge();
      // 已进入complete的任务已经确实落盘，确认过程中出现新编辑不撤销它的确认。
      for (const waiter of task.waiters.splice(0)) waiter.resolve();
      if (entry.pending !== task) return;
      entry.current = entry.retained ? task.content : undefined;
      entry.pending = undefined;
      this.setStatus(entry, {
        kind: "saved",
        identity: target.identity,
        lastWrittenAt: new Date().toISOString(),
        sizeBytes: new TextEncoder().encode(JSON.stringify(task.file)).length,
      });
    } catch (error) {
      if (entry.pending !== task) {
        for (const waiter of task.waiters.splice(0)) waiter.reject(error);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const humanMsg =
        task.operation === "update"
          ? task.stage === "write"
            ? `记忆已提交、尚未保存：${reason}`
            : `记忆已保存，批次确认尚未完成：${reason}`
          : task.stage === "activate"
            ? `候选空间已保存，激活尚未完成：${reason}`
            : `候选空间尚未保存，当前空间未替换：${reason}`;
      this.setStatus(entry, {
        kind: "failed",
        identity: target.identity,
        operation: task.operation,
        error: reason,
        humanMsg,
      });
      const failure =
        task.operation === "replacement"
          ? new ChatSnapshotReplacementSaveError(error, humanMsg)
          : error;
      for (const waiter of task.waiters.splice(0)) waiter.reject(failure);
    }
  }
  private setStatus(entry: ChatSaveEntry, status: ChatSnapshotSaveStatus): void {
    entry.status = status;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        console.error("保存状态订阅刷新失败", error);
      }
    }
  }
}
