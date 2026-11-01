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
  readonly clearLedger: (id: MemorySpaceId) => Promise<void>;
  readonly reportSwitchError: (error: unknown) => void;
}
interface SpaceOwner {
  target: ChatFileTarget;
  binding: ChatSpaceBinding;
}

interface PendingStructureRebuild {
  readonly spaceId: MemorySpaceId;
  readonly owner: SpaceOwner;
}

/** 在线空间的文件归属与离开/退休流程只有这一处维护。保存任务持有独立输入，
 * 卸载只释放 SQLite；成功替换才清辅助数据，并按原文件核对归属。 */
export class MemorySpaceLifecycle {
  // 最后文件归属凭据跨 SQLite 卸载保留；它不证明已加载，也不参与加载或空间枚举。
  // 同文件重入复用凭据，另一文件接管换新对象，让旧清理请求永久失效。
  private readonly owners = new Map<string, SpaceOwner>();
  private readonly pendingRebuilds = new Map<string, PendingStructureRebuild>();
  private switching: Promise<void> = Promise.resolve();
  private readonly ports: SpaceLifecyclePorts;

  constructor(ports: SpaceLifecyclePorts) {
    this.ports = ports;
  }

  saveSnapshot(unit: MemorySpaceBackup, saved?: () => Promise<void>): Promise<void> {
    const owner = this.owners.get(unit.space.id);
    if (!owner) {
      throw new Error("已提交空间缺少固定聊天归属");
    }
    return this.ports.persistence.saveCommitted(owner.target, owner.binding, unit, saved);
  }

  assertCanEdit(id: string): void {
    const owner = this.owners.get(id);
    if (owner && this.pendingRebuilds.has(owner.target.identity)) {
      throw new Error("预设重建尚待保存确认，请先重试保存");
    }
    if (owner && this.ports.persistence.hasPendingReplacement(owner.target.identity)) {
      throw new Error("候选空间尚未完成保存，请先重试保存");
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
    const request = { spaceId: input.memorySpaceId, owner };
    this.pendingRebuilds.set(owner.target.identity, request);
    try {
      const rebuilt = await this.ports.memory
        .structureRebuild(() => this.completeStructureRebuild(request))
        .rebuild(input);
      if (!rebuilt) {
        this.pendingRebuilds.delete(owner.target.identity);
      }
      return rebuilt;
    } catch (error) {
      // SQL 失败未提交，解除门控；文件或确认失败仍由保存任务持有本请求，等待重试。
      if (!(error instanceof MemoryCommitPersistenceError)) {
        this.pendingRebuilds.delete(owner.target.identity);
      }
      throw error;
    }
  }

  private async completeStructureRebuild(request: PendingStructureRebuild): Promise<void> {
    const identity = request.owner.target.identity;
    // 保存合并可再次调用旧确认，只有当前请求能够清资源并解除自己的门控。
    if (this.pendingRebuilds.get(identity) !== request) {
      return;
    }
    await this.ports.memory.exclusive(request.spaceId, async () => {
      if (this.pendingRebuilds.get(identity) !== request) {
        return;
      }
      // 清理期间持有 SQL writer，新的同 ID 激活必须等清理完成后才能接管。
      // 文件归属已换过时不清辅助；即使新 owner 已卸载，旧请求也不会恢复权限。
      if (this.owners.get(request.spaceId) === request.owner) {
        await this.ports.clearTasks(request.spaceId);
        await this.ports.clearLedger(request.spaceId);
        await this.ports.vector.purge({ memorySpaceId: request.spaceId });
      }
      this.pendingRebuilds.delete(identity);
    });
  }

  retire(id: MemorySpaceId, target: ChatFileTarget): Promise<void> {
    return this.ports.memory.exclusive(id, async (token) => {
      const owner = this.owners.get(id);
      // 原聊天的候选保存可迟到；同一领域 ID 已归其他文件时不能清除新 owner。
      if (owner && owner.target.identity !== target.identity) {
        return;
      }
      await this.ports.clearTasks(id);
      await this.ports.clearLedger(id);
      await this.ports.vector.purge({ memorySpaceId: id });
      await this.ports.assistant.clearSpaceHistory(id);
      await this.ports.memory.unload(id, token);
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
    // 每次提交已捕获保存任务；仅释放已完成保存的快照，失败输入仍由 persistence 保留。
    if (owner) {
      this.ports.persistence.release(owner.target.identity);
    }
  }
}
