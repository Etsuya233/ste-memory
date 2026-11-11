import { ChatSnapshotReplacementSaveError } from "../chat-mirror/chat-snapshot-persistence.ts";
import type { ChatSpaceManager } from "../chat-binding/chat-space-manager.ts";
import type { SavedFillBatch } from "../fill-tasks/fill-task-session.ts";
import type { MemorySpaceBackup } from "../memory-snapshot/snapshot.ts";
import type {
  HistoryProgress,
  HistorySettings,
  HistorySource,
  HistoryVersion,
  PreparedHistoryRestore,
} from "./history.ts";

interface HistoryStore {
  list(chatKey: string): Promise<HistoryVersion[]>;
  require(chatKey: string, id: string): Promise<HistoryVersion>;
  read(chatKey: string, id: string): Promise<MemorySpaceBackup>;
  rename(chatKey: string, id: string, name: string): Promise<void>;
  remove(chatKey: string, id: string): Promise<void>;
  save(input: {
    chatKey: string;
    id: string;
    createdAt: string;
    source: HistorySource;
    snapshot: MemorySpaceBackup;
    name?: string;
    progress?: HistoryProgress;
  }): Promise<HistoryVersion>;
  progress(chatKey: string): Promise<HistoryProgress | undefined>;
  setProgress(progress: HistoryProgress): Promise<void>;
  protect(...ids: string[]): () => void;
  trim(limit: number, chatKey?: string): Promise<void>;
}

interface HistoryPorts {
  readonly store: HistoryStore;
  readonly settings: () => HistorySettings;
  readonly now: () => string;
  readonly createId: () => string;
  readonly selection: (chatKey: string) => string;
  readonly capture: (chatKey: string) => Promise<MemorySpaceBackup>;
  readonly currentSnapshot: (chatKey: string) => MemorySpaceBackup | undefined;
  readonly normalize: (snapshot: MemorySpaceBackup) => Promise<MemorySpaceBackup>;
  readonly importSpace: ChatSpaceManager["importSpace"];
}

interface PendingAutomatic {
  readonly id: string;
  readonly createdAt: string;
  readonly snapshot: MemorySpaceBackup;
  readonly progress: HistoryProgress;
  error?: string;
}

function snapshotScope(snapshot: MemorySpaceBackup): string {
  return JSON.stringify([snapshot.space.id, snapshot.space.stableId]);
}

export class MemoryHistoryService {
  readonly #restoring = new Map<string, { release: () => void; verified: boolean }>();
  readonly #pending = new Map<string, PendingAutomatic>();
  readonly #automaticWrites = new Map<string, Promise<void>>();
  readonly #automaticListeners = new Set<(chatKey: string) => void>();

  private readonly ports: HistoryPorts;

  constructor(ports: HistoryPorts) {
    this.ports = ports;
  }

  list(chatKey: string): Promise<HistoryVersion[]> {
    this.ports.selection(chatKey);
    return this.ports.store.list(chatKey);
  }

  rename(chatKey: string, id: string, name: string): Promise<void> {
    this.ports.selection(chatKey);
    return this.ports.store.rename(chatKey, id, name);
  }

  remove(chatKey: string, id: string): Promise<void> {
    this.ports.selection(chatKey);
    return this.ports.store.remove(chatKey, id);
  }

  async read(chatKey: string, id: string): Promise<MemorySpaceBackup> {
    const selection = this.ports.selection(chatKey);
    const snapshot = await this.ports.store.read(chatKey, id);
    this.assertSelection(chatKey, selection);
    return snapshot;
  }

  async save(chatKey: string, name?: string): Promise<HistoryVersion> {
    const selection = this.ports.selection(chatKey);
    const snapshot = await this.ports.capture(chatKey);
    this.assertSelection(chatKey, selection);
    return this.ports.store.save({
      chatKey,
      id: this.ports.createId(),
      createdAt: this.ports.now(),
      source: "manual",
      snapshot,
      name,
    });
  }

  async prepareRestore(chatKey: string, id: string): Promise<PreparedHistoryRestore> {
    const generation = this.ports.selection(chatKey);
    if (this.#restoring.has(chatKey)) {
      throw new Error("上一次历史版本恢复尚未完成，请先重试保存");
    }
    const [version, current] = await Promise.all([
      this.ports.store.require(chatKey, id),
      this.ports.capture(chatKey),
    ]);
    this.assertSelection(chatKey, generation);
    return { chatKey, version, current, generation };
  }

  async restore(prepared: PreparedHistoryRestore): Promise<void> {
    const { chatKey, version, current, generation } = prepared;
    this.assertSelection(chatKey, generation);
    if (this.#restoring.has(chatKey)) {
      throw new Error("上一次历史版本恢复尚未完成，请先重试保存");
    }
    const beforeId = this.ports.createId();
    const operation = { release: this.ports.store.protect(version.id, beforeId), verified: false };
    this.#restoring.set(chatKey, operation);
    let savedBefore = false;
    try {
      const target = await this.ports.normalize(await this.ports.store.read(chatKey, version.id));
      this.assertSelection(chatKey, generation);
      await this.ports.importSpace(target, undefined, {
        beforeActivate: async () => {
          this.assertSelection(chatKey, generation);
          const snapshot = await this.ports.capture(chatKey);
          this.assertSelection(chatKey, generation);
          if (snapshot !== current) {
            throw new Error("当前记忆已变化，请重新查看摘要并确认恢复");
          }
          await this.ports.store.save({
            chatKey,
            id: beforeId,
            createdAt: this.ports.now(),
            source: "before-restore",
            snapshot,
          });
          savedBefore = true;
        },
        confirmed: async () => {
          operation.verified = true;
        },
      });
    } catch (error) {
      if (!(error instanceof ChatSnapshotReplacementSaveError)) {
        operation.release();
        this.#restoring.delete(chatKey);
        if (savedBefore) {
          try {
            await this.ports.store.trim(this.ports.settings().limit, chatKey);
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            throw new AggregateError(
              [error, cause],
              `${String(error)}。历史版本清理失败：${detail}`,
              { cause },
            );
          }
        }
      }
      throw error;
    }
    await this.finishRestore(chatKey);
  }

  async finishRestore(chatKey: string): Promise<void> {
    const operation = this.#restoring.get(chatKey);
    if (operation?.verified) {
      operation.release();
      this.#restoring.delete(chatKey);
      await this.ports.store.trim(this.ports.settings().limit, chatKey);
    }
  }

  trim(limit: number): Promise<void> {
    return this.ports.store.trim(limit);
  }

  onAutomaticChange(listener: (chatKey: string) => void): () => void {
    this.#automaticListeners.add(listener);
    return () => {
      this.#automaticListeners.delete(listener);
    };
  }

  automaticFailure(chatKey: string): string | undefined {
    const pending = this.#pending.get(chatKey);
    const current = this.ports.currentSnapshot(chatKey);
    return pending && current && snapshotScope(current) === pending.progress.spaceId
      ? pending.error
      : undefined;
  }

  resetAfterReplacement(chatKey: string, snapshot: MemorySpaceBackup): Promise<void> {
    return this.enqueueAutomatic(chatKey, async () => {
      const spaceId = snapshotScope(snapshot);
      const previous = await this.ports.store.progress(chatKey);
      if (previous?.spaceId !== spaceId) {
        this.#pending.delete(chatKey);
        await this.ports.store.setProgress({ chatKey, spaceId, established: true, floors: [] });
      }
    });
  }

  async recordSuccessfulFill({ chatKey, snapshot, newFloors }: SavedFillBatch): Promise<void> {
    await this.enqueueAutomatic(chatKey, async () => {
      const { enabled, interval } = this.ports.settings();
      if (!enabled) {
        return;
      }
      const spaceId = snapshotScope(snapshot);
      const stored = await this.ports.store.progress(chatKey);
      const current = this.ports.currentSnapshot(chatKey);
      if (current ? snapshotScope(current) !== spaceId : stored && stored.spaceId !== spaceId) {
        return;
      }
      const previous =
        stored?.spaceId === spaceId
          ? stored
          : { chatKey, spaceId, established: stored !== undefined, floors: [] };
      const pending = this.#pending.get(chatKey);
      const pendingProgress = pending?.progress.spaceId === spaceId ? pending.progress : undefined;
      const progress = {
        ...previous,
        floors: [
          ...new Set([...previous.floors, ...(pendingProgress?.floors ?? []), ...newFloors]),
        ],
      };
      if (pendingProgress || (progress.established && progress.floors.length < interval)) {
        await this.ports.store.setProgress(progress);
        return;
      }
      const next: PendingAutomatic = {
        id: this.ports.createId(),
        createdAt: this.ports.now(),
        snapshot,
        progress,
      };
      this.#pending.set(chatKey, next);
      try {
        await this.ports.store.setProgress(progress);
      } catch (cause) {
        next.error = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      }
      await this.saveAutomatic(chatKey, next, progress);
    });
  }

  async retryAutomatic(chatKey: string): Promise<void> {
    const selection = this.ports.selection(chatKey);
    await this.enqueueAutomatic(chatKey, async () => {
      this.assertSelection(chatKey, selection);
      const pending = this.#pending.get(chatKey);
      if (!pending) {
        throw new Error("当前聊天没有待重试的自动版本");
      }
      const current = await this.ports.capture(chatKey);
      const progress = await this.ports.store.progress(chatKey);
      this.assertSelection(chatKey, selection);
      if (snapshotScope(current) !== pending.progress.spaceId) {
        this.#pending.delete(chatKey);
        throw new Error("记忆空间已替换，原自动保存已结束");
      }
      await this.saveAutomatic(
        chatKey,
        pending,
        progress?.spaceId === pending.progress.spaceId ? progress : pending.progress,
      );
    });
  }

  private async saveAutomatic(
    chatKey: string,
    pending: PendingAutomatic,
    progress: HistoryProgress,
  ): Promise<void> {
    const capturedFloors = new Set(pending.progress.floors);
    try {
      await this.ports.store.save({
        chatKey,
        id: pending.id,
        createdAt: pending.createdAt,
        source: "automatic",
        snapshot: pending.snapshot,
        progress: {
          ...progress,
          established: true,
          floors: progress.floors.filter((floor) => !capturedFloors.has(floor)),
        },
      });
    } catch (cause) {
      pending.error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    }
    this.#pending.delete(chatKey);
    await this.ports.store.trim(this.ports.settings().limit, chatKey);
  }

  private enqueueAutomatic(chatKey: string, write: () => Promise<void>): Promise<void> {
    const previous = this.#automaticWrites.get(chatKey);
    const next = previous ? previous.catch(() => undefined).then(write) : write();
    this.#automaticWrites.set(chatKey, next);
    return next.finally(() => {
      if (this.#automaticWrites.get(chatKey) === next) {
        this.#automaticWrites.delete(chatKey);
      }
      for (const listener of this.#automaticListeners) {
        listener(chatKey);
      }
    });
  }

  private assertSelection(chatKey: string, selection: string): void {
    if (this.ports.selection(chatKey) !== selection) {
      throw new Error("聊天或记忆空间已变化，请重新确认历史版本操作");
    }
  }
}
