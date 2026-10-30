import type { MemoryField, MemoryRecord, MemorySpace, MemoryTable } from "../memory/index.ts";

/** Versioned, read-only cross-extension contract. No settings, credentials or write handles. */
export interface MemoryReadSnapshot {
  readonly space: MemorySpace;
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
  readonly records: readonly MemoryRecord[];
}

export interface MemoryReadContext {
  readonly revision: number;
  readonly chatIdentity: string | null;
  readonly chatName: string | null;
  readonly spaceId: string | null;
  readonly spaceName: string | null;
  readonly available: boolean;
  readonly message: string | null;
}

export interface MemoryReadApi {
  readonly version: 1;
  getContext(): MemoryReadContext;
  subscribe(listener: () => void): () => void;
  read(): Promise<{ readonly context: MemoryReadContext; readonly snapshot: MemoryReadSnapshot }>;
}

export class PublicMemoryReader implements MemoryReadApi {
  readonly version = 1;
  readonly #context: () => Omit<MemoryReadContext, "revision">;
  readonly #capture: (spaceId: string) => Promise<MemoryReadSnapshot>;
  readonly #listeners = new Set<() => void>();
  #revision = 0;

  constructor(
    context: () => Omit<MemoryReadContext, "revision">,
    capture: (spaceId: string) => Promise<MemoryReadSnapshot>,
  ) {
    this.#context = context;
    this.#capture = capture;
  }

  getContext(): MemoryReadContext {
    return { ...this.#context(), revision: this.#revision };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  invalidate(): void {
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }

  async read(): ReturnType<MemoryReadApi["read"]> {
    const context = this.getContext();
    if (!context.available || !context.spaceId)
      throw new Error(context.message ?? "当前记忆空间尚未就绪");
    const snapshot = await this.#capture(context.spaceId);
    const current = this.getContext();
    if (
      current.revision !== context.revision ||
      current.chatIdentity !== context.chatIdentity ||
      current.spaceId !== context.spaceId ||
      !current.available
    )
      throw new Error("读取期间记忆资料或对话已变化，请重新读取");
    return { context, snapshot };
  }
}
