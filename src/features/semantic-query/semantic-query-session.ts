import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import {
  createReadTimeDisplayTextResolver,
  type MemoryRecord,
  type MemorySpaceId,
} from "../memory/index.ts";
import type { VectorEmbeddingPort, VectorIndexRepository } from "../vector-index/index.ts";
import type { QueryVectorExecution } from "./query-vector-cache.ts";
import {
  createSemanticScores,
  semanticSourceKey,
  type SemanticScoreResult,
} from "./semantic-scores.ts";
import type {
  SemanticSqlEvaluationPort,
  PreparedSemanticSqlSource,
  SemanticSqlParams,
} from "./semantic-sql-port.ts";

export interface NamedSemanticScoreResult extends SemanticScoreResult {
  readonly name: string;
}
export interface SemanticSqlProgress {
  sqlPasses: number;
  sqlMs: number;
  preparedSources: number;
  queryTexts: number;
}
export interface SemanticQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly sources: readonly NamedSemanticScoreResult[];
  readonly truncated: boolean;
  readonly execution: { readonly sqlPasses: number; readonly sqlMs: number };
}
export interface SemanticQuerySessionInput {
  readonly sql: SemanticSqlEvaluationPort;
  readonly queryVectors: QueryVectorExecution;
  readonly vectors: Pick<VectorIndexRepository, "listVectors">;
  readonly embedding: VectorEmbeddingPort;
  readonly snapshot: MemorySpaceBackup;
  readonly lastUserMessage: string | null;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly onCleanupError?: (error: unknown) => void;
}
/** One fixed snapshot and one owner for cancellation, scoring and SQL re-execution. */
export async function createSemanticQuerySession(input: SemanticQuerySessionInput) {
  const { sql, signal, deadline, lastUserMessage } = input;
  let snapshot = structuredClone(input.snapshot);
  let closed = false;
  let cleanupError: unknown;
  const check = () => {
    signal.throwIfAborted();
    if (closed) throw new DOMException("语义查询会话已关闭", "AbortError");
    if (performance.now() >= deadline) throw new DOMException("语义查询超时", "TimeoutError");
  };
  const yieldExecution = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    check();
  };
  check();
  const display = createReadTimeDisplayTextResolver({
    getTable: async (id) => snapshot.tables.find((table) => table.id === id),
    getFields: async (id) => snapshot.fields.filter((field) => field.tableId === id),
    findRecord: async (tableId, id) =>
      snapshot.records.find((record) => record.tableId === tableId && record.id === id),
  });
  const fresh: MemoryRecord[] = [];
  for (let i = 0; i < snapshot.records.length; i++) {
    if (i % 100 === 0) await yieldExecution();
    const record = snapshot.records[i]!;
    fresh.push({ ...record, displayText: await display(record) });
  }
  snapshot = { ...snapshot, records: fresh };
  check();
  const opening = sql.openEvaluation(snapshot);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closed = true;
      input.queryVectors.close();
      signal.removeEventListener("abort", aborted);
      closing = opening.then((id) => sql.closeEvaluation(id));
    }
    return closing;
  };
  const aborted = () => {
    void close().catch((error) => {
      cleanupError = error;
      input.onCleanupError?.(error);
    });
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  let sessionId: string;
  try {
    sessionId = await opening;
    check();
  } catch (error) {
    await close();
    throw error;
  }
  const scoring = createSemanticScores({ ...input, snapshot });
  async function evaluate(
    sqlText: string,
    options: { params?: SemanticSqlParams; maxRows?: number; progress?: SemanticSqlProgress } = {},
  ): Promise<SemanticQueryResult> {
    const progress = options.progress ?? {
      sqlPasses: 0,
      sqlMs: 0,
      preparedSources: 0,
      queryTexts: 0,
    };
    const prepared = new Map<string, PreparedSemanticSqlSource>();
    const sources: NamedSemanticScoreResult[] = [];
    const texts = new Set<string>();
    let sqlMs = 0;
    for (let pass = 1; pass <= 17; pass++) {
      progress.sqlPasses = pass;
      check();
      if (sqlMs >= 1000) throw new Error("语义 SQL 累计执行超过 1 秒");
      const result = await sql.evaluateSemanticSql({
        params: options.params,
        maxRows: options.maxRows,
        sessionId,
        sql: sqlText,
        lastUserMessage,
        sources: [...prepared.values()],
        budgetMs: 1000 - sqlMs,
        remainingMs: deadline - performance.now(),
      });
      sqlMs += result.elapsedMs;
      progress.sqlMs = sqlMs;
      check();
      if (sqlMs > 1000) throw new Error("语义 SQL 累计执行超过 1 秒");
      if (result.status === "complete")
        return {
          columns: result.columns,
          rows: result.rows,
          sources,
          truncated: result.truncated ?? false,
          execution: { sqlPasses: pass, sqlMs },
        };
      const request = result.request;
      const key = semanticSourceKey(request);
      if (prepared.has(key)) throw new Error("语义评分源已供给，但 SQL 仍重复请求准备");
      if (prepared.size >= 16) throw new Error("单条 SQL 的语义评分源超过 16 个");
      if (!texts.has(request.query) && texts.size >= 4)
        throw new Error("单条 SQL 的不同查询文本超过 4 种");
      texts.add(request.query);
      progress.queryTexts = texts.size;
      const scored = await scoring.get(request);
      check();
      prepared.set(key, { ...request, rows: scored.rows });
      progress.preparedSources = prepared.size;
      sources.push({ ...scored, name: `semantic_scores#${sources.length + 1}` });
    }
    throw new Error("语义 SQL 重执行超过 17 轮");
  }
  return {
    snapshot,
    sessionId,
    scoring,
    check,
    close,
    statistics: () => ({
      queryVectorScope: "batch" as const,
      queryVectors: input.queryVectors.stats(),
      ...(cleanupError === undefined ? {} : { cleanupError: String(cleanupError) }),
    }),
    evaluate,
  };
}

export interface SemanticQueryRequest {
  readonly sql: string;
  readonly params?: SemanticSqlParams;
  readonly signal?: AbortSignal;
  readonly maxRows?: number;
}
export interface SemanticQueryResponse extends SemanticQueryResult {
  readonly diagnostics: SemanticSqlProgress & {
    readonly queryVectors: ReturnType<QueryVectorExecution["stats"]>;
  };
}
export type SemanticQueryExecutor = (
  spaceId: MemorySpaceId,
  request: SemanticQueryRequest,
) => Promise<SemanticQueryResponse>;
