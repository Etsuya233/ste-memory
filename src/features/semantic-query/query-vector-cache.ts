import type { VectorEmbeddingPort, VectorEmbeddingProfile } from "../vector-index/index.ts";

export interface QueryVectorResult {
  readonly values: readonly number[];
  readonly calls: number;
  readonly executionHits: number;
  readonly sharedHits: number;
}
export interface QueryVectorExecution {
  get(text: string): Promise<QueryVectorResult>;
  close(): void;
  stats(): { requests: number; executionHits: number; sharedHits: number };
}
interface CacheEntry {
  readonly values: readonly number[];
  readonly expires: number;
  readonly bytes: number;
}

/** Successful query vectors may outlive a batch; scores and records never enter this cache. */
export class QueryVectorCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;
  #configuration = "";
  #revision = 0;

  constructor(
    options: {
      now?: () => number;
      ttlMs?: number;
      maxEntries?: number;
      maxBytes?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? 5 * 60 * 1000;
    this.#maxEntries = options.maxEntries ?? 64;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  /** Configuration stays private; public cache keys only carry an opaque revision. */
  revisionFor(configuration: unknown): number {
    const fingerprint = JSON.stringify(configuration);
    if (fingerprint !== this.#configuration) {
      this.#configuration = fingerprint;
      this.#revision++;
      this.#entries.clear();
      this.#bytes = 0;
    }
    return this.#revision;
  }

  createExecution(input: {
    embedding: VectorEmbeddingPort;
    revision: number;
    signal: AbortSignal;
    isCurrent: () => boolean;
  }): QueryVectorExecution {
    const profile = structuredClone(input.embedding.getProfile());
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const pending = new Map<string, Promise<readonly number[]>>();
    let closed = false;
    const stats = { requests: 0, executionHits: 0, sharedHits: 0 };
    return {
      get: async (raw) => {
        signal.throwIfAborted();
        if (closed) throw new Error("查询向量执行已关闭");
        const text = raw.trim();
        if (!profile) throw new Error("尚未配置 embedding 连接");
        if (!text || text.length > Math.min(4000, profile.maxInputChars))
          throw new Error("查询向量输入为空或超过字符上限");
        const key = JSON.stringify([
          input.revision,
          profile.model,
          profile.version,
          profile.dimensions ?? null,
          text,
        ]);
        const existing = pending.get(key);
        if (existing) {
          stats.executionHits++;
          return { values: await existing, calls: 0, executionHits: 1, sharedHits: 0 };
        }
        const cached = this.#entries.get(key);
        if (cached && cached.expires > this.#now()) {
          this.#entries.delete(key);
          this.#entries.set(key, cached);
          pending.set(key, Promise.resolve(cached.values));
          stats.sharedHits++;
          return { values: cached.values, calls: 0, executionHits: 0, sharedHits: 1 };
        }
        if (cached) {
          this.#entries.delete(key);
          this.#bytes -= cached.bytes;
        }
        let abort!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        });
        const work = Promise.resolve().then(async () => {
          signal.throwIfAborted();
          stats.requests++;
          const result = await input.embedding.embed(text, signal);
          signal.throwIfAborted();
          validateVector(result, profile);
          const values = Object.freeze(Array.from(result));
          if (!closed && input.isCurrent() && input.revision === this.#revision) {
            const bytes = new TextEncoder().encode(key).byteLength + values.length * 8;
            if (bytes <= this.#maxBytes) {
              const previous = this.#entries.get(key);
              if (previous) {
                this.#entries.delete(key);
                this.#bytes -= previous.bytes;
              }
              this.#entries.set(key, { values, bytes, expires: this.#now() + this.#ttl });
              this.#bytes += bytes;
              while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
                const oldest = this.#entries.keys().next().value!;
                this.#bytes -= this.#entries.get(oldest)!.bytes;
                this.#entries.delete(oldest);
              }
            }
          }
          return values;
        });
        const request = Promise.race([work, interrupted]).finally(() => {
          signal.removeEventListener("abort", abort);
        });
        pending.set(key, request);
        try {
          return { values: await request, calls: 1, executionHits: 0, sharedHits: 0 };
        } catch (error) {
          if (pending.get(key) === request) pending.delete(key);
          throw error;
        }
      },
      close: () => {
        closed = true;
        controller.abort(new DOMException("查询向量执行已关闭", "AbortError"));
        pending.clear();
      },
      stats: () => ({ ...stats }),
    };
  }
}

function validateVector(values: readonly number[], profile: VectorEmbeddingProfile): void {
  let norm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error("查询向量包含非法数值");
    norm = Math.hypot(norm, value);
  }
  if (!values.length || !norm || !Number.isFinite(norm)) throw new Error("查询向量维度或数值异常");
  if (profile.dimensions !== undefined && values.length !== profile.dimensions)
    throw new Error("查询向量维度或数值异常");
}
