import type { MemorySpaceId } from "./memory-space.ts";
import type { MemoryTableId } from "./memory-table.ts";

export type MemoryRecordId = string & { readonly __brand: "MemoryRecordId" };
export type MemoryRecordHistoryId = string & { readonly __brand: "MemoryRecordHistoryId" };
export type MemoryRevisionId = string & { readonly __brand: "MemoryRevisionId" };
export type MemoryRevisionSource = "agent" | "user";
export type MemoryFieldValue = string | number | boolean | null | readonly string[];
export type MemoryRecordPayload = Readonly<Record<string, MemoryFieldValue>>;

export type MemoryEvidenceId = string & { readonly __brand: "MemoryEvidenceId" };
export type MemoryEvidenceSourceId = string | number;

export interface MemoryEvidenceSnapshot {
  readonly evidence_id: MemoryEvidenceId;
  readonly source_type: string;
  readonly source_id: MemoryEvidenceSourceId;
  readonly storage_mode: "snapshot";
  readonly content: string;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

export interface MemoryEvidenceReference {
  readonly evidence_id: MemoryEvidenceId;
  readonly source_type: string;
  readonly source_id: MemoryEvidenceSourceId;
  readonly storage_mode: "reference";
  readonly extraProps: Readonly<Record<string, unknown>>;
}

export type MemoryEvidence = MemoryEvidenceSnapshot | MemoryEvidenceReference;
export type MemoryEvidenceInput = {
  readonly source_type: string;
  readonly source_id: MemoryEvidenceSourceId;
  readonly content: string;
  readonly storage_mode: "snapshot" | "reference";
  readonly extraProps?: Readonly<Record<string, unknown>>;
};
export type MemoryFieldEvidence = Readonly<Record<string, readonly MemoryEvidence[]>>;

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
  readonly fieldEvidence?: MemoryFieldEvidence;
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
  readonly fieldEvidence?: MemoryFieldEvidence;
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
