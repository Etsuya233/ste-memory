import { ChatSnapshotSaveTask, type SavedChatContent } from "./chat-snapshot-save-task.ts";
import type { MemorySpaceBackup } from "../backup/index.ts";
import type { ChatSpaceBinding } from "../chat-binding/chat-space-manager.ts";
import { decodeChatMirrorFile } from "./chat-mirror-codec.ts";
import type { ChatMirrorFile } from "./chat-mirror-file.ts";
import {
  migrateLegacyFloorLedger,
  type LegacyFloorLedgerMigrationPorts,
} from "./legacy-floor-ledger-migration.ts";
import {
  snapshotSaveActions,
  type ChatSnapshotSaveStatus,
  type SnapshotCleanupStatus,
  type SnapshotSaveFailurePhase,
  type SnapshotSaveOperation,
} from "./snapshot-save-state.ts";
export { snapshotSaveActions } from "./snapshot-save-state.ts";
export type {
  ChatSnapshotSaveStatus,
  SnapshotCleanupStatus,
  SnapshotSaveActions,
  SnapshotSaveFailurePhase,
  SnapshotSaveOperation,
} from "./snapshot-save-state.ts";

/** 加载出的快照可要求走现有候选保存流程；回调仅在完整文件核验成功后执行。 */
export interface LoadedChatSnapshot {
  readonly snapshot: MemorySpaceBackup;
  readonly replacement?: { readonly confirmed: () => Promise<void> };
}

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
const IDLE_STATUS: ChatSnapshotSaveStatus = { kind: "idle", cleanup: { kind: "idle" } };

export class ChatSnapshotReplacementSaveError extends Error {
  readonly humanMsg: string;
  constructor(cause: unknown, humanMsg: string) {
    super(humanMsg, { cause });
    this.name = "ChatSnapshotReplacementSaveError";
    this.humanMsg = this.message;
  }
}

interface SaveRequest {
  readonly task: ChatSnapshotSaveTask;
  readonly operationId: number;
}

type SaveLifecycle =
  | { readonly kind: "idle" }
  | {
      readonly kind: "queued" | "saving" | "verifying" | "confirming";
      readonly request: SaveRequest;
      readonly attempt: Promise<void>;
    }
  | {
      readonly kind: "failed";
      readonly request: SaveRequest;
      readonly phase: SnapshotSaveFailurePhase;
      readonly error: string;
      readonly humanMsg: string;
    }
  | {
      readonly kind: "released-failure";
      readonly identity: string;
      readonly operationId: number;
      readonly operation: SnapshotSaveOperation;
      readonly phase: SnapshotSaveFailurePhase;
      readonly error: string;
      readonly humanMsg: string;
    }
  | {
      readonly kind: "submitted" | "verified";
      readonly identity: string;
      readonly operationId: number;
      readonly operation: SnapshotSaveOperation;
      readonly completedAt: string;
      readonly sizeBytes: number;
    };

type CleanupLifecycle =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly operationIds: readonly number[];
      readonly attempt: Promise<void>;
    }
  | Extract<SnapshotCleanupStatus, { kind: "failed" }>;

interface ChatSaveEntry {
  content?: SavedChatContent;
  active: boolean;
  save: SaveLifecycle;
  status: ChatSnapshotSaveStatus;
  queue: Promise<void>;
  retirements: Map<number, () => Promise<void>>;
  cleanup: CleanupLifecycle;
}

export interface SnapshotFailure {
  readonly identity: string;
  readonly operationId: number;
  readonly operation: SnapshotSaveOperation;
  readonly phase: "submit" | "verify" | "confirm" | "retire";
  readonly error: unknown;
}

/** 普通输入只在当前聊天保留；关键候选跨切聊保留唯一输入及清理权限。 */
export class ChatSnapshotPersistence {
  readonly #entries = new Map<string, ChatSaveEntry>();
  readonly #listeners = new Set<(status: ChatSnapshotSaveStatus) => void>();
  readonly #failures = new Set<(failure: SnapshotFailure) => void>();
  #operationSequence = 0;
  private readonly store: ChatSnapshotFileStore;
  private readonly appVersion: () => string;
  private readonly legacyFloorLedger?: LegacyFloorLedgerMigrationPorts;
  constructor(
    store: ChatSnapshotFileStore,
    appVersion: () => string,
    legacyFloorLedger?: LegacyFloorLedgerMigrationPorts,
  ) {
    this.store = store;
    this.appVersion = appVersion;
    this.legacyFloorLedger = legacyFloorLedger;
  }

  hasPendingWrites(): boolean {
    return [...this.#entries.values()].some((entry) => this.pendingRequest(entry) !== undefined);
  }

  getStatus(identity?: string): ChatSnapshotSaveStatus {
    return identity === undefined
      ? IDLE_STATUS
      : (this.#entries.get(identity)?.status ?? IDLE_STATUS);
  }

  onStatusChange(listener: (status: ChatSnapshotSaveStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onFailure(listener: (failure: SnapshotFailure) => void): () => void {
    this.#failures.add(listener);
    return () => {
      this.#failures.delete(listener);
    };
  }

  hasPendingCleanup(identity: string): boolean {
    return (this.#entries.get(identity)?.retirements.size ?? 0) > 0;
  }

  retryCleanup(identity: string): Promise<void> {
    const entry = this.entry(identity);
    if (entry.cleanup.kind === "running") {
      return entry.cleanup.attempt;
    }
    if (!entry.retirements.size) {
      throw new Error("当前聊天没有待清理的旧辅助数据");
    }
    const actions = snapshotSaveActions(entry.status, entry.active);
    if (actions.busy || entry.status.kind === "failed" || !entry.active) {
      throw new Error(actions.disabledReason ?? "请先处理当前保存失败");
    }
    return this.startCleanup(entry, identity);
  }

  private startCleanup(entry: ChatSaveEntry, identity: string): Promise<void> {
    const completion = Promise.withResolvers<void>();
    entry.cleanup = {
      kind: "running",
      operationIds: [...entry.retirements.keys()],
      attempt: completion.promise,
    };
    this.publish(entry);
    void this.cleanRetired(entry, identity).then(completion.resolve, completion.reject);
    return completion.promise;
  }

  private async cleanRetired(entry: ChatSaveEntry, identity: string): Promise<void> {
    const failures: string[] = [];
    for (const [operationId, retire] of entry.retirements) {
      try {
        await retire();
        entry.retirements.delete(operationId);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        this.reportFailure({
          identity,
          operationId,
          operation: "replacement",
          phase: "retire",
          error,
        });
      }
    }
    entry.cleanup = failures.length
      ? {
          kind: "failed",
          operationIds: [...entry.retirements.keys()],
          message: `记忆已保存，旧辅助数据清理未完成：${failures.join("；")}`,
        }
      : { kind: "idle" };
    this.publish(entry);
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
    const entry = this.#entries.get(identity);
    const task = entry && this.pendingRequest(entry)?.task;
    if (task?.operation !== "replacement") {
      throw new Error("当前聊天没有待确认候选");
    }
    this.store.restore(task.content.target, task.file, task.content.binding);
  }

  release(identity: string): void {
    const entry = this.#entries.get(identity);
    if (entry) {
      entry.active = false;
      if (this.pendingRequest(entry)?.task.operation !== "replacement") {
        entry.content = undefined;
        if (entry.save.kind === "failed") {
          const { request, phase, error, humanMsg } = entry.save;
          entry.save = {
            kind: "released-failure",
            identity: request.task.content.target.identity,
            operationId: request.operationId,
            operation: request.task.operation,
            phase,
            error,
            humanMsg,
          };
          this.publish(entry);
        } else if (this.pendingRequest(entry)) {
          entry.save = { kind: "idle" };
          this.publish(entry);
        }
      }
    }
  }

  hasPendingReplacement(identity: string): boolean {
    const entry = this.#entries.get(identity);
    return entry !== undefined && this.pendingRequest(entry)?.task.operation === "replacement";
  }

  async load(
    target: ChatFileTarget,
    binding?: ChatSpaceBinding,
  ): Promise<LoadedChatSnapshot | undefined> {
    if (this.hasPendingReplacement(target.identity)) {
      return { snapshot: this.current(target.identity)!.snapshot };
    }
    const raw = await this.store.read(target);
    if (raw === undefined) {
      return undefined;
    }
    const file = decodeChatMirrorFile(raw);
    if (!file) {
      throw new Error("对话元数据中的记忆快照损坏或版本无法识别");
    }
    if (binding !== undefined && file.spaceId !== binding.spaceId) {
      throw new Error("对话元数据中的记忆快照与空间绑定不一致");
    }
    if (binding && this.legacyFloorLedger) {
      return migrateLegacyFloorLedger(target, binding, file.data, this.legacyFloorLedger);
    }
    return { snapshot: file.data };
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
    retire?: () => Promise<void>,
  ): Promise<void> {
    return this.schedule(
      new ChatSnapshotSaveTask(
        { target, snapshot, binding },
        "replacement",
        this.appVersion(),
        confirmed,
        retire,
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
    const pending = this.pendingRequest(entry);
    if (pending?.task.operation === "replacement") {
      if (
        entry.save.kind === "queued" ||
        entry.save.kind === "saving" ||
        entry.save.kind === "verifying" ||
        entry.save.kind === "confirming"
      ) {
        return entry.save.attempt;
      }
      return this.enqueue(entry, pending, assertActive);
    }
    return this.schedule(
      new ChatSnapshotSaveTask({ target, snapshot, binding }, "force-sync", this.appVersion()),
      assertActive,
    );
  }

  private entry(identity: string): ChatSaveEntry {
    let entry = this.#entries.get(identity);
    if (!entry) {
      entry = {
        status: IDLE_STATUS,
        save: { kind: "idle" },
        cleanup: { kind: "idle" },
        queue: Promise.resolve(),
        active: true,
        retirements: new Map(),
      };
      this.#entries.set(identity, entry);
    }
    return entry;
  }

  private schedule(task: ChatSnapshotSaveTask, assertActive?: () => void): Promise<void> {
    const entry = this.entry(task.content.target.identity);
    if (this.pendingRequest(entry)?.task.operation === "replacement") {
      throw new Error("候选空间尚待核验，请先强制同步");
    }
    const request: SaveRequest = { task, operationId: ++this.#operationSequence };
    entry.content = task.content;
    // 普通提交在 SQLite 交接的同一同步步骤发布 metadata 并请求宿主保存。
    // 宿主自行串行文件保存；本队列等待完成，供强制同步在旧调用结束后捕获核验。
    if (task.operation === "update") {
      const completion = Promise.withResolvers<void>();
      entry.save = { kind: "saving", request, attempt: completion.promise };
      void this.submitAndVerify(entry, request).then(completion.resolve, completion.reject);
      const saving = completion.promise;
      entry.queue = Promise.allSettled([entry.queue, saving]).then(() => undefined);
      return saving;
    }
    return this.enqueue(entry, request, assertActive);
  }

  private enqueue(
    entry: ChatSaveEntry,
    request: SaveRequest,
    assertActive?: () => void,
  ): Promise<void> {
    const completion = Promise.withResolvers<void>();
    entry.save = { kind: "queued", request, attempt: completion.promise };
    this.publish(entry);
    const run = entry.queue.then(() => {
      if (this.pendingRequest(entry) !== request) {
        throw new Error("同步操作已过期，请在当前聊天重新同步");
      }
      return this.submitAndVerify(entry, request, assertActive);
    });
    entry.queue = run.catch(() => undefined);
    void run.then(completion.resolve, completion.reject);
    return completion.promise;
  }

  private async submitAndVerify(
    entry: ChatSaveEntry,
    request: SaveRequest,
    assertActive?: () => void,
  ): Promise<void> {
    const task = request.task;
    const identity = task.content.target.identity;
    let phase: SnapshotSaveFailurePhase = "submit";
    try {
      assertActive?.();
      this.advance(entry, request, "saving");
      if (this.pendingRequest(entry) !== request) {
        return;
      }
      await task.submit(this.store);
      if (this.pendingRequest(entry) !== request) {
        return;
      }
      if (task.operation !== "update") {
        phase = "verify";
        this.advance(entry, request, "verifying");
        if (this.pendingRequest(entry) !== request) {
          return;
        }
        await task.verify(this.store);
        if (this.pendingRequest(entry) !== request) {
          return;
        }
        phase = "confirm";
        this.advance(entry, request, "confirming");
        if (this.pendingRequest(entry) !== request) {
          return;
        }
        await task.confirm();
      }
      // 旧提交完成不能把较新的内容标记为已核验。
      if (this.pendingRequest(entry) !== request) {
        return;
      }
      if (!entry.active) {
        entry.content = undefined;
      }
      entry.save = {
        kind: task.operation === "update" ? "submitted" : "verified",
        identity,
        operationId: request.operationId,
        operation: task.operation,
        completedAt: new Date().toISOString(),
        sizeBytes: task.sizeBytes,
      };
      // 新 ID 空间退休不改变已确认的文件结果；同 ID 操作仍保留原确认回调。
      // 先登记清理再发布完成，订阅者重入时能看到完整操作结果与清理归属。
      if (task.retire) {
        entry.retirements.set(request.operationId, task.retire);
        if (entry.cleanup.kind === "running") {
          entry.cleanup = { ...entry.cleanup, operationIds: [...entry.retirements.keys()] };
          this.publish(entry);
          await entry.cleanup.attempt;
        } else {
          await this.startCleanup(entry, identity);
        }
      } else {
        this.publish(entry);
      }
    } catch (error) {
      if (this.pendingRequest(entry) !== request) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.reportFailure({
        identity,
        operationId: request.operationId,
        operation: task.operation,
        phase,
        error,
      });
      if (this.pendingRequest(entry) !== request) {
        throw error;
      }
      const humanMsg =
        phase === "confirm"
          ? `聊天文件已核验，操作收尾尚未完成，请重试：${reason}`
          : task.operation === "replacement"
            ? `新内容已载入，聊天文件保存尚未核验；旧任务、向量和 Agent 会话尚未清理：${reason}`
            : `记忆已提交、尚未核验：${reason}`;
      entry.save = {
        kind: "failed",
        request,
        phase,
        error: reason,
        humanMsg,
      };
      this.publish(entry);
      throw task.operation === "replacement"
        ? new ChatSnapshotReplacementSaveError(error, humanMsg)
        : error;
    }
  }

  private pendingRequest(entry: ChatSaveEntry): SaveRequest | undefined {
    switch (entry.save.kind) {
      case "queued":
      case "saving":
      case "verifying":
      case "confirming":
      case "failed":
        return entry.save.request;
      case "idle":
      case "released-failure":
      case "submitted":
      case "verified":
        return undefined;
    }
  }

  private advance(
    entry: ChatSaveEntry,
    request: SaveRequest,
    kind: "saving" | "verifying" | "confirming",
  ): void {
    const current = entry.save;
    if (
      (current.kind !== "queued" &&
        current.kind !== "saving" &&
        current.kind !== "verifying" &&
        current.kind !== "confirming") ||
      current.request !== request
    ) {
      throw new Error("保存操作归属已过期");
    }
    entry.save = { ...current, kind };
    this.publish(entry);
  }

  private publish(entry: ChatSaveEntry): void {
    const { save, cleanup } = entry;
    const cleanupStatus: SnapshotCleanupStatus =
      cleanup.kind === "running"
        ? { kind: "running", operationIds: cleanup.operationIds }
        : cleanup;
    if (save.kind === "released-failure") {
      entry.status = { ...save, kind: "failed", cleanup: cleanupStatus };
    } else if (!("request" in save)) {
      entry.status = { ...save, cleanup: cleanupStatus };
    } else {
      const { task, operationId } = save.request;
      const identity = task.content.target.identity;
      if (save.kind === "failed") {
        entry.status = {
          kind: "failed",
          phase: save.phase,
          error: save.error,
          humanMsg: save.humanMsg,
          identity,
          operationId,
          operation: task.operation,
          cleanup: cleanupStatus,
        };
      } else {
        entry.status = {
          kind: save.kind,
          identity,
          operationId,
          operation: task.operation,
          cleanup: cleanupStatus,
        };
      }
    }
    for (const listener of this.#listeners) {
      try {
        listener(entry.status);
      } catch (error) {
        console.error("保存状态订阅刷新失败", error);
      }
    }
  }

  private reportFailure(failure: SnapshotFailure): void {
    for (const listener of this.#failures) {
      try {
        listener(failure);
      } catch (error) {
        console.error("保存诊断记录失败", error);
      }
    }
  }
}
