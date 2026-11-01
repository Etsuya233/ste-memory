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
  /** 读取当前宿主已加载 metadata，普通加载不下载聊天。 */
  read(target: ChatFileTarget): Promise<unknown>;
  /** 同步更新两键并即时进入原生保存，中间不能 await。 */
  submit(target: ChatFileTarget, file: ChatMirrorFile, binding: ChatSpaceBinding): Promise<void>;
  /** 本页返回待确认候选时恢复宿主 metadata，不发保存请求。 */
  restore(target: ChatFileTarget, file: ChatMirrorFile, binding: ChatSpaceBinding): void;
  /** 仅关键操作和强制同步读取固定文件；返回原始两个键。 */
  verify(target: ChatFileTarget): Promise<Record<string, unknown>>;
}
export type SnapshotSaveOperation = "update" | "replacement" | "force-sync";
export type ChatSnapshotSaveStatus =
  | { readonly kind: "idle" }
  | {
      readonly kind: "saving" | "verifying";
      readonly identity: string;
      readonly operation: SnapshotSaveOperation;
    }
  | {
      readonly kind: "submitted" | "verified";
      readonly identity: string;
      readonly completedAt: string;
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
  content?: SavedChatContent;
  active: boolean;
  pending?: ChatSnapshotSaveTask;
  status: ChatSnapshotSaveStatus;
  queue: Promise<void>;
  attempt?: Promise<void>;
}

/** 普通输入只在当前聊天保留；关键候选跨切聊保留唯一输入及清理权限。 */
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
    const entry = this.entry(target.identity);
    entry.active = true;
    entry.content = structuredClone({ target, snapshot, binding });
  }

  current(identity: string): SavedChatContent | undefined {
    return this.#entries.get(identity)?.content;
  }

  restoreCandidate(identity: string): void {
    const task = this.#entries.get(identity)?.pending;
    if (task?.operation !== "replacement") {
      throw new Error("当前聊天没有待确认候选");
    }
    this.store.restore(task.content.target, task.file, task.content.binding);
  }

  release(identity: string): void {
    const entry = this.#entries.get(identity);
    if (entry) {
      entry.active = false;
      if (entry.pending?.operation !== "replacement") {
        entry.content = undefined;
        entry.pending = undefined;
      }
    }
  }

  hasPendingReplacement(identity: string): boolean {
    return this.#entries.get(identity)?.pending?.operation === "replacement";
  }

  async load(target: ChatFileTarget, spaceId?: string): Promise<MemorySpaceBackup | undefined> {
    if (this.hasPendingReplacement(target.identity)) {
      return this.current(target.identity)?.snapshot;
    }
    const raw = await this.store.read(target);
    if (raw === undefined) {
      return undefined;
    }
    const file = decodeChatMirrorFile(raw);
    if (!file) {
      throw new Error("对话元数据中的记忆快照损坏或版本无法识别");
    }
    if (spaceId !== undefined && file.spaceId !== spaceId) {
      throw new Error("对话元数据中的记忆快照与空间绑定不一致");
    }
    return file.data;
  }

  saveCommitted(
    target: ChatFileTarget,
    binding: ChatSpaceBinding,
    snapshot: MemorySpaceBackup,
  ): Promise<void> {
    return this.schedule(
      new ChatSnapshotSaveTask({ target, snapshot, binding }, "update", this.appVersion()),
    );
  }

  replace(
    target: ChatFileTarget,
    snapshot: MemorySpaceBackup,
    binding: ChatSpaceBinding,
    confirmed?: () => Promise<void>,
  ): Promise<void> {
    return this.schedule(
      new ChatSnapshotSaveTask(
        { target, snapshot, binding },
        "replacement",
        this.appVersion(),
        confirmed,
      ),
    );
  }

  forceSync(
    target: ChatFileTarget,
    binding: ChatSpaceBinding,
    snapshot: MemorySpaceBackup,
    assertActive: () => void,
  ): Promise<void> {
    const entry = this.entry(target.identity);
    if (entry.pending?.operation === "replacement") {
      if (entry.status.kind === "saving" || entry.status.kind === "verifying") {
        return entry.attempt!;
      }
      return this.enqueue(entry, entry.pending, assertActive);
    }
    return this.schedule(
      new ChatSnapshotSaveTask({ target, snapshot, binding }, "force-sync", this.appVersion()),
      assertActive,
    );
  }

  private entry(identity: string): ChatSaveEntry {
    let entry = this.#entries.get(identity);
    if (!entry) {
      entry = { status: IDLE_STATUS, queue: Promise.resolve(), active: true };
      this.#entries.set(identity, entry);
    }
    return entry;
  }

  private schedule(task: ChatSnapshotSaveTask, assertActive?: () => void): Promise<void> {
    const entry = this.entry(task.content.target.identity);
    if (entry.pending?.operation === "replacement") {
      throw new Error("候选空间尚待核验，请先强制同步");
    }
    entry.content = task.content;
    entry.pending = task;
    // 普通提交在 SQLite 交接的同一同步步骤发布 metadata 并请求宿主保存。
    // 宿主自行串行文件保存；本队列等待完成，供强制同步在旧调用结束后捕获核验。
    if (task.operation === "update") {
      const saving = this.submitAndVerify(entry, task);
      entry.queue = Promise.allSettled([entry.queue, saving]).then(() => undefined);
      return saving;
    }
    const completion = this.enqueue(entry, task, assertActive);
    this.setStatus(entry, {
      kind: "saving",
      identity: task.content.target.identity,
      operation: task.operation,
    });
    return completion;
  }

  private enqueue(
    entry: ChatSaveEntry,
    task: ChatSnapshotSaveTask,
    assertActive?: () => void,
  ): Promise<void> {
    const run = entry.queue.then(() => {
      if (entry.pending !== task) {
        throw new Error("同步操作已过期，请在当前聊天重新同步");
      }
      assertActive?.();
      return this.submitAndVerify(entry, task);
    });
    entry.attempt = run;
    entry.queue = run.catch(() => undefined);
    return run;
  }

  private async submitAndVerify(entry: ChatSaveEntry, task: ChatSnapshotSaveTask): Promise<void> {
    const identity = task.content.target.identity;
    this.setStatus(entry, { kind: "saving", identity, operation: task.operation });
    try {
      await task.submit(this.store);
      if (task.operation !== "update") {
        this.setStatus(entry, { kind: "verifying", identity, operation: task.operation });
        await task.verify(this.store);
      }
      // 旧提交完成不能把较新的内容标记为已核验。
      if (entry.pending !== task) {
        return;
      }
      entry.pending = undefined;
      if (!entry.active) {
        entry.content = undefined;
      }
      this.setStatus(entry, {
        kind: task.operation === "update" ? "submitted" : "verified",
        identity,
        completedAt: new Date().toISOString(),
        sizeBytes: task.sizeBytes,
      });
    } catch (error) {
      if (entry.pending !== task) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const humanMsg =
        task.operation === "replacement"
          ? `候选空间已启用、尚未核验，旧辅助数据保留：${reason}`
          : `记忆已提交、尚未核验：${reason}`;
      this.setStatus(entry, {
        kind: "failed",
        identity,
        operation: task.operation,
        error: reason,
        humanMsg,
      });
      throw task.operation === "replacement"
        ? new ChatSnapshotReplacementSaveError(error, humanMsg)
        : error;
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
