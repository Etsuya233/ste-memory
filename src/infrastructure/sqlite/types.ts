import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type { MemoryReadSnapshot } from "../../features/public-read/public-read-api.ts";
import type { MacroSqlEvaluationPort } from "../../features/macros/macro-evaluation-port.ts";
import type { SemanticSqlEvaluationPort } from "../../features/semantic-query/semantic-sql-port.ts";
import type { SqlExecutionResult, SqlSchemaEntry } from "../../features/sql-console/sql-console.ts";
import type {
  MemoryEvidence,
  MemoryField,
  MemoryRecord,
  MemoryRecordHistory,
  MemorySpace,
  MemoryTable,
} from "../../features/memory/index.ts";

export interface SqliteEntities {
  space: MemorySpace;
  table: MemoryTable;
  field: MemoryField;
  record: MemoryRecord;
  history: MemoryRecordHistory;
  evidence: MemoryEvidence;
}
export type SqliteEntityKind = keyof SqliteEntities;
export type SqliteView = "write" | "committed";
export type SqliteBind = string | number | null | Uint8Array;
export interface SqliteExecution {
  spaceId: string;
  sql: string;
  bind?: readonly SqliteBind[];
  view?: SqliteView;
  access?: "read" | "write" | "host";
  /** Actual SQLite VM interruption budget, independent of message Promise timeouts. */
  budgetMs?: number;
  maxRows?: number;
  /** Restrict raw Agent SQL to the enabled digest, excluding internal system tables. */
  allowedTables?: Readonly<Record<string, readonly string[]>>;
}
export interface SqliteConsoleResult extends SqlExecutionResult {
  /** Ordinary statements before this query have already executed exactly once. */
  readonly semanticStatement?: { readonly sql: string; readonly remainingSql: string };
}
export interface SqliteMemoryClient extends MacroSqlEvaluationPort, SemanticSqlEvaluationPort {
  executeConsole(spaceId: string, sql: string): Promise<SqliteConsoleResult>;
  consoleSchema(spaceId: string): Promise<readonly SqlSchemaEntry[]>;
  importSpace(snapshot: MemorySpaceBackup): Promise<void>;
  exportSpace(spaceId: string, view?: SqliteView): Promise<MemorySpaceBackup>;
  readSnapshot(spaceId: string): Promise<MemoryReadSnapshot>;
  getEntity<K extends SqliteEntityKind>(
    spaceId: string,
    kind: K,
    id: string,
    view?: SqliteView,
  ): Promise<SqliteEntities[K] | undefined>;
  listEntities<K extends SqliteEntityKind>(
    spaceId: string,
    kind: K,
    view?: SqliteView,
  ): Promise<SqliteEntities[K][]>;
  putEntity<K extends SqliteEntityKind>(
    spaceId: string,
    kind: K,
    entity: SqliteEntities[K],
  ): Promise<void>;
  deleteEntity(spaceId: string, kind: SqliteEntityKind, id: string): Promise<void>;
  exec(input: SqliteExecution): Promise<Record<string, unknown>[]>;
  begin(spaceId: string): Promise<void>;
  commit(spaceId: string): Promise<void>;
  rollback(spaceId: string): Promise<void>;
  savepoint(spaceId: string, name: string): Promise<void>;
  release(spaceId: string, name: string): Promise<void>;
  rollbackTo(spaceId: string, name: string): Promise<void>;
  publish(spaceId: string): Promise<void>;
  removeSpace(spaceId: string): Promise<void>;
  close(): Promise<void>;
}
export type SqliteRequest = { id: number; method: keyof SqliteMemoryClient; args: unknown[] };
export type SqliteResponse = { id: number; result?: unknown; error?: string };
