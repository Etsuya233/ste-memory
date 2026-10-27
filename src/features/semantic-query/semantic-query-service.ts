import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import type {
  createSemanticQuerySession,
  SemanticQueryExecutor,
  SemanticQuerySessionInput,
  SemanticSqlProgress,
} from "./semantic-query-session.ts";

export class SemanticQueryError extends Error {
  readonly diagnostics: SemanticSqlProgress & {
    readonly queryVectors?: { requests: number; executionHits: number; sharedHits: number };
  };
  constructor(
    message: string,
    diagnostics: SemanticQueryError["diagnostics"],
    options: ErrorOptions,
  ) {
    super(message, options);
    this.diagnostics = diagnostics;
    this.name = "SemanticQueryError";
  }
}

/** Each invocation owns a fresh committed snapshot and cancellation scope. */
export function createSemanticQueryExecutor(input: {
  snapshot: (spaceId: MemorySpaceId) => Promise<MemorySpaceBackup>;
  createSession: (
    snapshot: MemorySpaceBackup,
    context: Pick<SemanticQuerySessionInput, "signal" | "deadline" | "lastUserMessage">,
  ) => ReturnType<typeof createSemanticQuerySession>;
  onCleanupError: (error: unknown) => void;
}): SemanticQueryExecutor {
  return async (spaceId, request) => {
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const deadline = performance.now() + 10_000;
    const progress = { sqlPasses: 0, sqlMs: 0, preparedSources: 0, queryTexts: 0 };
    let session: Awaited<ReturnType<typeof createSemanticQuerySession>> | undefined;
    try {
      signal.throwIfAborted();
      const snapshot = await input.snapshot(spaceId);
      signal.throwIfAborted();
      session = await input.createSession(snapshot, {
        signal,
        deadline,
        lastUserMessage: null,
      });
      const result = await session.evaluate(request.sql, {
        params: request.params ?? {},
        maxRows: request.maxRows,
        progress,
      });
      signal.throwIfAborted();
      return {
        ...result,
        diagnostics: { ...progress, queryVectors: session.statistics().queryVectors },
      };
    } catch (error) {
      throw new SemanticQueryError(
        error instanceof Error ? error.message : String(error),
        { ...progress, ...(session ? { queryVectors: session.statistics().queryVectors } : {}) },
        { cause: error },
      );
    } finally {
      if (session) await session.close().catch(input.onCleanupError);
    }
  };
}
