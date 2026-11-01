import { ChatSnapshotSaveTask, type SavedChatContent } from "./chat-snapshot-save-task.ts";
import type { MemorySpaceBackup } from "../backup/index.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-manager.ts";
import { decodeChatMirrorFile } from "./chat-mirror-codec.ts";
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

interface ChatSaveEntry {
  /** 当前已提交内容；未落盘的候选不能替代它。 */
  committedContent?: SavedChatContent;
  retention: "active" | "released";
  pendingSave?: ChatSnapshotSaveTask;
  status: ChatSnapshotSaveStatus;
  queue: Promise<void>;
}

/** 每个文件拥有独立串行队列；SQLite 卸载不取消其保存与确认任务。 */
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
    return [...this.#entries.values()].some((entry) => entry.pendingSave !== undefined);
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
    const entry = this.entry(target.identity);
    entry.retention = "active";
    entry.committedContent = structuredClone({ target, snapshot, binding });
  }

  current(identity: string): SavedChatContent | undefined {
    const entry = this.#entries.get(identity);
    const task = entry?.pendingSave;
    if (task?.phase === "activate") {
      return task.content;
    }
    return entry?.committedContent;
  }

  release(identity: string): void {
    const entry = this.#entries.get(identity);
    if (!entry) {
      return;
    }
    entry.retention = "released";
    if (!entry.pendingSave) {
      entry.committedContent = undefined;
    }
  }

  hasSavedReplacement(identity: string): boolean {
    return this.#entries.get(identity)?.pendingSave?.phase === "activate";
  }

  hasPendingReplacement(identity: string): boolean {
    return this.#entries.get(identity)?.pendingSave?.operation === "replacement";
  }

  async load(target: ChatFileTarget, spaceId?: string): Promise<MemorySpaceBackup | undefined> {
    // 返回未保存聊天时先恢复已提交内存内容，磁盘可能仍是较早的快照。
    if (this.#entries.get(target.identity)?.pendingSave) {
      return this.current(target.identity)?.snapshot;
    }
    const raw = await this.store.read(target);
    if (this.#entries.get(target.identity)?.pendingSave) {
      return this.current(target.identity)?.snapshot;
    }
    if (raw === undefined) {
      return undefined;
    }
    const file = decodeChatMirrorFile(raw);
    if (!file) {
      throw new Error("对话文件中的记忆快照损坏或版本无法识别");
    }
    if (spaceId !== undefined && file.spaceId !== spaceId) {
      throw new Error("对话文件中的记忆快照与空间绑定不一致");
    }
    return file.data;
  }

  saveCommitted(
    target: ChatFileTarget,
    binding: ChatSpaceBinding,
    snapshot: MemorySpaceBackup,
    saved?: () => Promise<void>,
  ): Promise<void> {
    const task = new ChatSnapshotSaveTask(
      { target, snapshot, binding },
      { operation: "update", savedBatches: saved ? [saved] : [] },
      this.appVersion(),
    );
    return this.schedule(task);
  }

  replace(
    target: ChatFileTarget,
    snapshot: MemorySpaceBackup,
    binding: ChatSpaceBinding,
    activate: () => Promise<void>,
  ): Promise<void> {
    const task = new ChatSnapshotSaveTask(
      { target, snapshot, binding },
      { operation: "replacement", activate },
      this.appVersion(),
    );
    return this.schedule(task);
  }

  retry(identity: string): Promise<void> {
    const entry = this.#entries.get(identity);
    if (!entry?.pendingSave) {
      return Promise.resolve();
    }
    // 任务保留实际阶段；文件已成功时只继续 complete 或 activate。
    return this.enqueue(entry, entry.pendingSave);
  }

  private entry(identity: string): ChatSaveEntry {
    let entry = this.#entries.get(identity);
    if (!entry) {
      entry = { status: IDLE_STATUS, queue: Promise.resolve(), retention: "active" };
      this.#entries.set(identity, entry);
    }
    return entry;
  }

  private schedule(task: ChatSnapshotSaveTask): Promise<void> {
    const entry = this.entry(task.content.target.identity);
    task.supersede(entry.pendingSave);
    if (task.operation === "update") {
      entry.committedContent = task.content;
    }
    entry.pendingSave = task;
    const completion = this.enqueue(entry, task);
    this.setStatus(entry, {
      kind: "saving",
      identity: task.content.target.identity,
      operation: task.operation,
    });
    return completion;
  }

  private enqueue(entry: ChatSaveEntry, task: ChatSnapshotSaveTask): Promise<void> {
    const completion = task.waitForCompletion();
    const run = entry.queue.then(() => this.saveLatest(entry, task));
    // 调度链保持可用；业务调用通过各自 waiter 接收失败并由明确重试继续。
    entry.queue = run.catch(() => undefined);
    return completion;
  }

  private async saveLatest(entry: ChatSaveEntry, task: ChatSnapshotSaveTask): Promise<void> {
    if (entry.pendingSave !== task) {
      return;
    }
    const identity = task.content.target.identity;
    this.setStatus(entry, { kind: "saving", identity, operation: task.operation });
    try {
      await task.writeAndConfirm(this.store, () => entry.pendingSave === task);
      task.resolveWaiters();
      if (entry.pendingSave !== task) {
        return;
      }
      entry.committedContent = entry.retention === "active" ? task.content : undefined;
      entry.pendingSave = undefined;
      this.setStatus(entry, {
        kind: "saved",
        identity,
        lastWrittenAt: new Date().toISOString(),
        sizeBytes: task.sizeBytes,
      });
    } catch (error) {
      if (entry.pendingSave !== task) {
        task.rejectWaiters(error);
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const humanMsg = task.failureMessage(reason);
      this.setStatus(entry, {
        kind: "failed",
        identity,
        operation: task.operation,
        error: reason,
        humanMsg,
      });
      task.rejectWaiters(
        task.operation === "replacement"
          ? new ChatSnapshotReplacementSaveError(error, humanMsg)
          : error,
      );
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
