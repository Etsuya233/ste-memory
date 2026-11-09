import { RecordsClearCleanupError } from "../../features/space-maintenance/space-maintenance-service.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type { ChatSpaceBinding } from "../../features/chat-binding/chat-space-context.ts";
import type {
  ChatFileTarget,
  ChatSnapshotPersistence,
} from "../../features/chat-mirror/chat-snapshot-persistence.ts";
import type { FillTaskService } from "../../features/fill-tasks/fill-task-service.ts";
import { MemoryCommitPersistenceError } from "../../features/memory/index.ts";
import type { SpaceStructureRebuildInput } from "../../features/space-maintenance/space-structure-rebuild.ts";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import type { QueryChatStore } from "../../features/query-chat/session-store.ts";
import type { VectorIndexService } from "../../features/vector-index/index.ts";
import type { SqliteMemoryStore } from "./sqlite-memory-store.ts";

interface SpaceLifecyclePorts {
  readonly memory: SqliteMemoryStore;
  readonly persistence: ChatSnapshotPersistence;
  readonly tasks: Pick<FillTaskService, "cancelAll" | "interruptForChatChange">;
  readonly vector: Pick<VectorIndexService, "stop" | "pauseSpace" | "purge">;
  readonly assistant: Pick<QueryChatStore, "cancelSpace" | "clearSpaceHistory">;
  readonly clearTasks: (id: MemorySpaceId) => Promise<void>;
  readonly reportSwitchError: (error: unknown) => void;
}
interface SpaceOwner {
  target: ChatFileTarget;
  binding: ChatSpaceBinding;
}

interface PendingSpaceOperation {
  readonly spaceId: MemorySpaceId;
  readonly owner: SpaceOwner;
  readonly kind: "rebuild" | "clear-records";
}

/** 写入许可由当前归属和操作推导，读取许可与文件保存结果独立。 */
export type SpaceWriteState =
  | { readonly kind: "editable" }
  | {
      readonly kind: "synchronizing" | "replacing" | "candidate-unverified";
      readonly identity: string;
      readonly message: string;
    };

export class SpaceWriteBlockedError extends Error {
  readonly code: Exclude<SpaceWriteState["kind"], "editable">;
  constructor(state: Exclude<SpaceWriteState, { kind: "editable" }>) {
    super(state.message);
    this.name = "SpaceWriteBlockedError";
    this.code = state.kind;
  }
}

/** 在线空间的文件归属与离开/退休流程只有这一处维护。保存任务持有独立输入，
 * 卸载只释放 SQLite；成功替换才清辅助数据，并按原文件核对归属。 */
export class MemorySpaceLifecycle {
  // 最后文件归属凭据跨 SQLite 卸载保留；它不证明已加载，也不参与加载或空间枚举。
  // 同文件重入复用凭据，另一文件接管换新对象，让旧清理请求永久失效。
  private readonly owners = new Map<string, SpaceOwner>();
  private readonly pendingOperations = new Map<
    string,
    PendingSpaceOperation | { readonly kind: "replacement" }
  >();
  private readonly synchronizing = new Map<SpaceOwner, { token: symbol; done: Promise<void> }>();
  private switching: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly ports: SpaceLifecyclePorts;

  constructor(ports: SpaceLifecyclePorts) {
    this.ports = ports;
  }

  onWriteStateChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyWriteState(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.ports.reportSwitchError(error);
      }
    }
  }

  saveSnapshot(unit: MemorySpaceBackup): Promise<void> {
    const owner = this.owners.get(unit.space.id);
    if (!owner) {
      throw new Error("已提交空间缺少固定聊天归属");
    }
    return this.ports.persistence.saveCommitted(owner.target, owner.binding, unit);
  }

  async forceSync(id: string, assertActive: () => void): Promise<void> {
    assertActive();
    const owner = this.owners.get(id);
    if (!owner) {
      throw new Error("当前空间没有聊天归属");
    }
    if (this.pendingOperations.get(owner.target.identity)?.kind === "replacement") {
      throw new Error("正在导入或切换空间，请等待保存交接完成");
    }
    if (this.synchronizing.has(owner)) {
      throw new Error("该空间正在强制同步");
    }
    // 在第一个 await 前门控本 owner 的新写入；已持 writer 的批次仍可完成。
    // 同 ID 被另一聊天接管后使用新 owner，不受旧核验和旧 finally 影响。
    const operation = Symbol("force-sync");
    let finish!: () => void;
    const done = new Promise<void>((complete) => {
      finish = complete;
    });
    this.synchronizing.set(owner, { token: operation, done });
    this.notifyWriteState();
    try {
      await this.ports.memory.whenIdle(id);
      assertActive();
      if (this.owners.get(id) !== owner) {
        throw new Error("当前空间归属已变化");
      }
      const snapshot = await this.ports.memory.snapshot(id);
      assertActive();
      if (this.owners.get(id) !== owner || !snapshot) {
        throw new Error("当前空间归属已变化");
      }
      // 不跨网络持有 SQL writer：关键操作核验成功后的辅助清理也需独占该空间。
      await this.ports.persistence.forceSync(owner.target, owner.binding, snapshot, assertActive);
    } finally {
      if (this.synchronizing.get(owner)?.token === operation) {
        this.synchronizing.delete(owner);
        finish();
        this.notifyWriteState();
      }
    }
  }

  async beginFillBatch(id: MemorySpaceId, signal: AbortSignal): Promise<symbol> {
    const owner = this.owners.get(id);
    // 已入队的填表在批次边界等待临时核验，不把同步门控当作模型执行失败。
    // 末次检查与 begin 的同步部分连在一起，避免空闲 await 后重新穿过门控。
    while (true) {
      signal.throwIfAborted();
      if (this.owners.get(id) !== owner) {
        throw new Error("填表批次所属聊天已变化");
      }
      const syncing = owner && this.synchronizing.get(owner);
      if (!syncing) {
        return this.ports.memory.begin(id);
      }
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => {
          signal.removeEventListener("abort", cancelled);
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancelled, { once: true });
        void syncing.done.then(() => {
          signal.removeEventListener("abort", cancelled);
          resolve();
        });
      });
    }
  }

  getWriteState(id: string): SpaceWriteState {
    const owner = this.owners.get(id);
    if (owner && this.synchronizing.has(owner)) {
      return {
        kind: "synchronizing",
        identity: owner.target.identity,
        message: "正在强制同步，请等待核验完成",
      };
    }
    if (owner && this.pendingOperations.has(owner.target.identity)) {
      return {
        kind: "replacing",
        identity: owner.target.identity,
        message: "空间替换尚待核验，请先强制同步",
      };
    }
    if (owner && this.ports.persistence.hasPendingReplacement(owner.target.identity)) {
      return {
        kind: "candidate-unverified",
        identity: owner.target.identity,
        message: "候选空间尚未完成保存，请先重试保存",
      };
    }
    return { kind: "editable" };
  }

  assertCanEdit(id: string): void {
    const state = this.getWriteState(id);
    if (state.kind !== "editable") {
      throw new SpaceWriteBlockedError(state);
    }
  }

  async activate(
    target: ChatFileTarget,
    binding: ChatSpaceBinding,
    unit: MemorySpaceBackup,
  ): Promise<void> {
    await this.ports.memory.whenIdle(unit.space.id);
    await this.ports.memory.replace(unit);
    const previous = this.owners.get(unit.space.id);
    if (previous?.target.identity === target.identity) {
      previous.target = target;
      previous.binding = binding;
    } else {
      this.owners.set(unit.space.id, { target, binding });
    }
  }

  async unload(id: MemorySpaceId, target: ChatFileTarget): Promise<void> {
    await this.ports.memory.whenIdle(id);
    if (this.owners.get(id)?.target.identity !== target.identity) {
      return;
    }
    await this.ports.memory.unload(id);
  }

  async stopWrites(id: MemorySpaceId): Promise<void> {
    this.assertCanEdit(id);
    await this.cancelWrites(id);
  }

  /** 门控按聊天建立，覆盖旧空间停止与新空间激活，交接给保存任务后释放。 */
  assertCanReplace(target: ChatFileTarget): void {
    if (
      this.pendingOperations.has(target.identity) ||
      this.ports.persistence.hasPendingReplacement(target.identity)
    ) {
      throw new Error("当前对话的空间替换尚未完成，请先处理保存结果");
    }
  }

  async prepareReplacement(
    target: ChatFileTarget,
    oldId: MemorySpaceId | undefined,
  ): Promise<() => void> {
    this.assertCanReplace(target);
    if (oldId) {
      this.assertCanEdit(oldId);
    }
    const operation = { kind: "replacement" as const };
    this.pendingOperations.set(target.identity, operation);
    this.notifyWriteState();
    const release = () => {
      if (this.pendingOperations.get(target.identity) === operation) {
        this.pendingOperations.delete(target.identity);
        this.notifyWriteState();
      }
    };
    try {
      if (oldId) {
        await this.cancelWrites(oldId);
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async cancelWrites(id: MemorySpaceId): Promise<void> {
    await this.ports.tasks.cancelAll(id);
    await this.ports.vector.stop({ memorySpaceId: id });
    this.ports.assistant.cancelSpace(id);
    await this.ports.memory.whenIdle(id);
  }

  async rebuildStructure(input: SpaceStructureRebuildInput): Promise<boolean> {
    this.assertCanEdit(input.memorySpaceId);
    const owner = this.owners.get(input.memorySpaceId);
    if (!owner) {
      throw new Error("重建空间缺少固定聊天归属");
    }
    const request: PendingSpaceOperation = { spaceId: input.memorySpaceId, owner, kind: "rebuild" };
    this.pendingOperations.set(owner.target.identity, request);
    this.notifyWriteState();
    try {
      this.ports.assistant.cancelSpace(request.spaceId);
      await this.ports.vector.stop({ memorySpaceId: request.spaceId });
      await this.ports.memory.whenIdle(request.spaceId);
      if (this.owners.get(request.spaceId) !== owner) {
        throw new Error("空间归属已变化，重建操作已过期");
      }
      const rebuilt = await this.ports.memory
        .structureRebuild((snapshot) =>
          this.ports.persistence.replace(owner.target, snapshot, owner.binding, () =>
            this.confirmSpaceOperation(request),
          ),
        )
        .rebuild(input);
      if (!rebuilt) {
        this.pendingOperations.delete(owner.target.identity);
        this.notifyWriteState();
      }
      return rebuilt;
    } catch (error) {
      // SQL 失败未提交，解除门控；文件或确认失败仍由保存任务持有本请求，等待重试。
      if (!(error instanceof MemoryCommitPersistenceError)) {
        this.pendingOperations.delete(owner.target.identity);
        this.notifyWriteState();
      }
      throw error;
    }
  }

  async clearRecords(id: MemorySpaceId): Promise<boolean> {
    this.assertCanEdit(id);
    const owner = this.owners.get(id);
    if (!owner) {
      throw new Error("清除记录缺少固定聊天归属");
    }
    const request: PendingSpaceOperation = { spaceId: id, owner, kind: "clear-records" };
    this.pendingOperations.set(owner.target.identity, request);
    this.notifyWriteState();
    try {
      this.ports.assistant.cancelSpace(id);
      await this.ports.vector.stop({ memorySpaceId: id });
      await this.ports.memory.whenIdle(id);
      if (this.owners.get(id) !== owner) {
        throw new Error("空间归属已变化，清除操作已过期");
      }
      const candidate = await this.ports.memory.exclusive(id, async (token) => {
        const current = await this.ports.memory.snapshot(id);
        if (!current) {
          return undefined;
        }
        const snapshot = { ...current, records: [], history: [], evidence: [], floorLedger: [] };
        await this.ports.memory.replace(snapshot, token);
        return snapshot;
      });
      if (!candidate) {
        this.pendingOperations.delete(owner.target.identity);
        this.notifyWriteState();
        return false;
      }
      await this.ports.persistence.replace(owner.target, candidate, owner.binding, () =>
        this.confirmSpaceOperation(request),
      );
      return true;
    } catch (error) {
      if (!this.ports.persistence.hasPendingReplacement(owner.target.identity)) {
        this.pendingOperations.delete(owner.target.identity);
        this.notifyWriteState();
      }
      throw error;
    }
  }

  private async confirmSpaceOperation(request: PendingSpaceOperation): Promise<void> {
    const identity = request.owner.target.identity;
    // 保存合并可再次调用旧确认，只有当前请求能够清资源并解除自己的门控。
    if (this.pendingOperations.get(identity) !== request) {
      return;
    }
    await this.ports.memory.exclusive(request.spaceId, async () => {
      if (this.pendingOperations.get(identity) !== request) {
        return;
      }
      // 清理期间持有 SQL writer，新的同 ID 激活必须等清理完成后才能接管。
      // 文件归属已换过时不清辅助；即使新 owner 已卸载，旧请求也不会恢复权限。
      if (this.owners.get(request.spaceId) === request.owner) {
        try {
          await this.ports.clearTasks(request.spaceId);
          await this.ports.vector.purge({ memorySpaceId: request.spaceId });
          await this.ports.assistant.clearSpaceHistory(request.spaceId);
        } catch (cause) {
          if (request.kind === "clear-records") {
            throw new RecordsClearCleanupError(request.spaceId, cause);
          }
          throw cause;
        }
      }
      this.pendingOperations.delete(identity);
      this.notifyWriteState();
    });
  }

  captureRetirement(id: MemorySpaceId, target: ChatFileTarget): () => Promise<void> {
    const owner = this.owners.get(id);
    if (!owner || owner.target.identity !== target.identity) {
      throw new Error("待退休空间的聊天归属已变化");
    }
    const progress = { next: 0 };
    return () => this.retire(id, owner, progress);
  }

  private retire(
    id: MemorySpaceId,
    expectedOwner: SpaceOwner,
    progress: { next: number },
  ): Promise<void> {
    return this.ports.memory.exclusive(id, async (token) => {
      const owner = this.owners.get(id);
      // 原聊天的候选保存可迟到；同一领域 ID 已归其他文件时不能清除新 owner。
      if (owner !== expectedOwner) {
        return;
      }
      const steps = [
        ["任务历史", () => this.ports.clearTasks(id)],
        ["向量", () => this.ports.vector.purge({ memorySpaceId: id })],
        ["Agent 会话", () => this.ports.assistant.clearSpaceHistory(id)],
        ["运行空间", () => this.ports.memory.unload(id, token)],
      ] as const;
      for (; progress.next < steps.length; progress.next++) {
        const [name, remove] = steps[progress.next]!;
        try {
          await remove();
        } catch (cause) {
          throw new Error(
            `旧${name}清理失败（${id}）：${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
      }
      this.owners.delete(id);
    });
  }

  switchChat(
    previousId: MemorySpaceId | undefined,
    automaticFillStopped: Promise<void>,
    loadCurrentChat: () => Promise<void>,
  ): Promise<void> {
    const next = this.switching.then(async () => {
      await automaticFillStopped;
      await this.ports.tasks.interruptForChatChange();
      if (previousId) {
        await this.leaveChat(previousId);
      }
      await loadCurrentChat();
    });
    this.switching = next.catch(this.ports.reportSwitchError);
    return this.switching;
  }

  private async leaveChat(id: MemorySpaceId): Promise<void> {
    await this.ports.vector.pauseSpace(id);
    await this.ports.memory.whenIdle(id);
    const owner = this.owners.get(id);
    await this.ports.memory.unload(id);
    // 普通完整快照随离开释放；仅待确认关键操作由 persistence 保留唯一候选。
    if (owner) {
      this.ports.persistence.release(owner.target.identity);
    }
  }
}
