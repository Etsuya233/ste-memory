import {
  decodeHistoryVersion,
  encodeHistoryVersion,
  type HistoryProgress,
  type HistorySource,
  type HistoryVersion,
} from "../../features/memory-history/history.ts";
import type { MemorySpaceBackup } from "../../features/memory-snapshot/snapshot.ts";
import type { SteMemoryDatabase } from "./database.ts";

export class IndexedDbMemoryHistory {
  readonly #protected = new Set<string>();

  private readonly db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.db = db;
  }

  async list(chatKey: string): Promise<HistoryVersion[]> {
    return this.db.memoryHistory
      .where("[chatKey+createdAt]")
      .between([chatKey, ""], [chatKey, "\uffff"], true, true)
      .reverse()
      .toArray();
  }

  async require(chatKey: string, id: string): Promise<HistoryVersion> {
    const version = await this.db.memoryHistory.get(id);
    if (!version || version.chatKey !== chatKey) {
      throw new Error("当前聊天没有此历史版本");
    }
    return version;
  }

  async read(chatKey: string, id: string): Promise<MemorySpaceBackup> {
    const [version, row] = await this.db.transaction(
      "r",
      this.db.memoryHistory,
      this.db.memoryHistoryPayloads,
      async () => Promise.all([this.require(chatKey, id), this.db.memoryHistoryPayloads.get(id)]),
    );
    if (!row) {
      throw new Error("历史版本的压缩载荷缺失");
    }
    return decodeHistoryVersion(version, row.payload);
  }

  async rename(chatKey: string, id: string, name: string): Promise<void> {
    if (!name.trim()) {
      throw new Error("请输入历史版本名称");
    }
    await this.db.transaction("rw", this.db.memoryHistory, async () => {
      await this.require(chatKey, id);
      await this.db.memoryHistory.update(id, { name: name.trim() });
    });
  }

  async remove(chatKey: string, id: string): Promise<void> {
    await this.db.transaction(
      "rw",
      this.db.memoryHistory,
      this.db.memoryHistoryPayloads,
      async () => {
        await this.require(chatKey, id);
        if (this.#protected.has(id)) {
          throw new Error("历史版本正在恢复，请等待操作结束");
        }
        await this.db.memoryHistory.delete(id);
        await this.db.memoryHistoryPayloads.delete(id);
      },
    );
  }

  async save(input: {
    chatKey: string;
    id: string;
    createdAt: string;
    source: HistorySource;
    snapshot: MemorySpaceBackup;
    name?: string;
    progress?: HistoryProgress;
  }): Promise<HistoryVersion> {
    const { chatKey, id, createdAt, source, snapshot, name, progress } = input;
    try {
      const { version, payload } = await encodeHistoryVersion(
        chatKey,
        id,
        createdAt,
        source,
        snapshot,
        name,
      );
      await this.db.transaction(
        "rw",
        this.db.memoryHistory,
        this.db.memoryHistoryPayloads,
        this.db.memoryHistoryProgress,
        async () => {
          await this.db.memoryHistory.add(version);
          await this.db.memoryHistoryPayloads.add({ id, payload });
          if (progress) {
            await this.db.memoryHistoryProgress.put(progress);
          }
        },
      );
      return version;
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === "QuotaExceededError" || cause.message.includes("QuotaExceededError"))
      ) {
        throw new Error("本机存储空间不足。请导出或删除部分历史版本后重试。", { cause });
      }
      throw cause;
    }
  }

  progress(chatKey: string): Promise<HistoryProgress | undefined> {
    return this.db.memoryHistoryProgress.get(chatKey);
  }

  async setProgress(progress: HistoryProgress): Promise<void> {
    await this.db.memoryHistoryProgress.put(progress);
  }

  protect(...ids: string[]): () => void {
    for (const id of ids) {
      this.#protected.add(id);
    }
    return () => {
      for (const id of ids) {
        this.#protected.delete(id);
      }
    };
  }

  async trim(limit: number, chatKey?: string): Promise<void> {
    await this.db.transaction(
      "rw",
      this.db.memoryHistory,
      this.db.memoryHistoryPayloads,
      async () => {
        const versions =
          chatKey === undefined
            ? await this.db.memoryHistory.orderBy("[chatKey+createdAt]").reverse().toArray()
            : await this.list(chatKey);
        const counts = new Map<string, number>();
        const removed: string[] = [];
        for (const version of versions) {
          if (version.source === "manual" || this.#protected.has(version.id)) {
            continue;
          }
          const count = (counts.get(version.chatKey) ?? 0) + 1;
          counts.set(version.chatKey, count);
          if (count > limit) {
            removed.push(version.id);
          }
        }
        await this.db.memoryHistory.bulkDelete(removed);
        await this.db.memoryHistoryPayloads.bulkDelete(removed);
      },
    );
  }
}
