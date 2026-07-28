import type { MemorySpaceId } from "./memory-space.ts";
import type { MemoryTableId } from "./memory-table.ts";

export type MemoryRecordId = string & { readonly __brand: "MemoryRecordId" };
export type MemoryRecordHistoryId = string & { readonly __brand: "MemoryRecordHistoryId" };
export type MemoryRevisionId = string & { readonly __brand: "MemoryRevisionId" };
export type MemoryRevisionSource = "agent" | "user";
export type MemoryFieldValue = string | number | boolean | null | readonly string[];
export type MemoryRecordPayload = Readonly<Record<string, MemoryFieldValue>>;

export type MemoryRecordSource =
  | { readonly type: "manual" }
  | {
      readonly type: "source";
      readonly sourceTime: string | null;
      readonly sourceLocation: string | null;
    };

export interface MemoryRecord {
  readonly id: MemoryRecordId;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly payload: MemoryRecordPayload;
  readonly displayText: string;
  readonly source: MemoryRecordSource;
  readonly revisionId: MemoryRevisionId;
  readonly revisionSource: MemoryRevisionSource;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryRecordHistory {
  readonly id: MemoryRecordHistoryId;
  readonly recordId: MemoryRecordId;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly payload: MemoryRecordPayload;
  readonly displayText: string;
  readonly source: MemoryRecordSource;
  readonly previousRevisionId: MemoryRevisionId;
  readonly previousRevisionSource: MemoryRevisionSource;
  readonly revisionId: MemoryRevisionId;
  readonly revisionSource: MemoryRevisionSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string;
}
