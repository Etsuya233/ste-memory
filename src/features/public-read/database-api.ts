import type { MemoryField, MemorySpace, MemoryTable } from "../memory/index.ts";

export type MemorySqlScalar = string | number | null;
export interface MemoryDatabaseBinding {
  readonly chatIdentity: string;
  readonly spaceId: string;
}
export interface MemoryDatabaseSchema {
  /** Changes when this space is loaded/reimported; stable across record publications. */
  readonly databaseKey: string;
  readonly space: MemorySpace;
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
  /** Queryable structure identity, independent of record revisions and publication. */
  readonly schemaKey: string;
  readonly columns: Readonly<Record<string, readonly string[]>>;
}
export interface MemorySqlView {
  readonly name: string;
  readonly select: string;
  readonly columns?: readonly string[];
}
export interface MemoryRegisterViewsInput extends MemoryDatabaseBinding {
  readonly schemaKey: string;
  readonly namespace: string;
  readonly views: readonly MemorySqlView[];
}
export interface MemoryDatabaseQueryInput extends MemoryDatabaseBinding {
  readonly schemaKey: string;
  readonly namespace: string;
  readonly sql: string;
  readonly params?: Readonly<Record<string, MemorySqlScalar>>;
  readonly maxRows?: number;
  readonly budgetMs?: number;
}
export interface MemoryDatabaseQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly MemorySqlScalar[])[];
  readonly elapsedMs: number;
  readonly truncated: boolean;
  readonly maxRows: number;
}
export interface MemoryDatabaseApi {
  readonly version: 1;
  describe(input: MemoryDatabaseBinding): Promise<MemoryDatabaseSchema>;
  /** Atomically replaces this namespace's transient views, in dependency order. */
  registerViews(input: MemoryRegisterViewsInput): Promise<void>;
  query(input: MemoryDatabaseQueryInput): Promise<MemoryDatabaseQueryResult>;
}

/** Worker port; current-chat authorization stays at the public API boundary. */
export interface MemoryDatabasePort {
  describeDatabase(spaceId: string): Promise<MemoryDatabaseSchema>;
  registerDatabaseViews(input: MemoryRegisterViewsInput): Promise<void>;
  queryDatabase(input: MemoryDatabaseQueryInput): Promise<MemoryDatabaseQueryResult>;
}
