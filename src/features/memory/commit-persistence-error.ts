import type { MemoryRecord } from "./domain/index.ts";

/** The database commit succeeded; exporting, caching or persisting its snapshot failed. */
export class MemoryCommitPersistenceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "MemoryCommitPersistenceError";
  }
}

/** Carries the exact committed record so callers must not submit the mutation again. */
export class MemoryRecordSaveError extends Error {
  readonly record: MemoryRecord;
  constructor(record: MemoryRecord, cause: MemoryCommitPersistenceError) {
    super(cause.message, { cause });
    this.record = record;
    this.name = "MemoryRecordSaveError";
  }
}
