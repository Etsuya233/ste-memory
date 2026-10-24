import type { MemorySpaceId } from "../memory/index.ts";

export type SqlValue = string | number | bigint | null | Uint8Array;

/** Arrays preserve duplicate column names and SQLite's column order. */
export interface SqlResultSet {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly SqlValue[])[];
}

export interface SqlExecutionResult {
  readonly results: readonly SqlResultSet[];
  readonly changes: number;
  readonly transactionOpen: boolean;
  readonly elapsedMs: number;
}

export interface SqlSchemaEntry {
  readonly name: string;
  readonly type: string;
  readonly sql: string | null;
  readonly columns: readonly { readonly name: string; readonly type: string }[];
}

/** Manual console capability is deliberately separate from the Agent's read-only SQL port. */
export interface SqlConsole {
  execute(spaceId: MemorySpaceId, sql: string): Promise<SqlExecutionResult>;
  schema(spaceId: MemorySpaceId): Promise<readonly SqlSchemaEntry[]>;
}
