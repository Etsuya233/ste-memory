import type { MemorySpaceId } from "../../features/memory/index.ts";
import type { VectorIndexService } from "../../features/vector-index/index.ts";

/** SQLite已提交事件调度当前空间索引核对，网络刷新失败独立报告。 */
export class VectorIndexChangeSync {
  #spaceId: MemorySpaceId | undefined;
  #pending: Promise<void> = Promise.resolve();
  #dirty = false;
  private readonly vector: VectorIndexService;
  private readonly readEnabled: () => boolean;
  private readonly reportError: (error: unknown) => void;
  constructor(
    vector: VectorIndexService,
    readEnabled: () => boolean,
    reportError: (error: unknown) => void,
  ) {
    this.vector = vector;
    this.readEnabled = readEnabled;
    this.reportError = reportError;
  }
  activate(spaceId: MemorySpaceId | undefined): void {
    this.#spaceId = spaceId;
    if (spaceId) this.committed(spaceId);
  }
  committed(spaceId: MemorySpaceId): void {
    if (this.#spaceId !== spaceId) return;
    this.#dirty = true;
    this.#pending = this.#pending
      .then(async () => {
        if (!this.#dirty) return;
        this.#dirty = false;
        const active = this.#spaceId;
        if (active && this.readEnabled()) await this.vector.reconcile({ memorySpaceId: active });
      })
      .catch(this.reportError);
  }
  async refreshSettings(): Promise<void> {
    const id = this.#spaceId;
    if (!this.readEnabled()) {
      if (id) await this.vector.stop({ memorySpaceId: id });
      return;
    }
    this.vector.resumeConnection();
    if (id) this.committed(id);
    await this.#pending;
  }
  flush(): Promise<void> {
    return this.#pending;
  }
}
