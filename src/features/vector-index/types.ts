import type { MemoryRecordId, MemorySpaceId, MemoryTableId } from "../memory/index.ts";

export type VectorTaskStatus =
  "queued" | "running" | "succeeded" | "failed" | "obsolete" | "cancelled" | "interrupted";
export type VectorTaskSource = "manual" | "automatic";
export type VectorScope = {
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId?: MemoryTableId;
  readonly recordId?: MemoryRecordId;
};

export interface VectorEmbeddingProfile {
  readonly model: string;
  readonly version: string;
  readonly dimensions?: number;
  readonly maxInputChars: number;
}
export interface VectorEmbeddingPort {
  getProfile(): VectorEmbeddingProfile | null;
  embed(input: string, signal: AbortSignal): Promise<readonly number[]>;
}
export type VectorEmbeddingErrorCategory =
  "authentication" | "connection" | "capacity" | "input" | "other";
export class VectorEmbeddingRequestError extends Error {
  readonly category: VectorEmbeddingErrorCategory;
  readonly global: boolean;
  constructor(message: string, category: VectorEmbeddingErrorCategory, global = false) {
    super(message);
    this.name = "VectorEmbeddingRequestError";
    this.category = category;
    this.global = global;
  }
}

export interface VectorTask {
  readonly id: string;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly recordId: MemoryRecordId;
  readonly recordDisplayText: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly fingerprint: string;
  readonly input: string;
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  readonly source: VectorTaskSource;
  readonly force: boolean;
  readonly predecessorId: string | null;
  readonly status: VectorTaskStatus;
  readonly waitReason: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}
export interface RecordVector {
  readonly id: string;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly recordId: MemoryRecordId;
  readonly groupId: string;
  readonly fingerprint: string;
  readonly values: readonly number[];
  readonly model: string;
  readonly version: string;
  readonly updatedAt: string;
}
export interface VectorSuppression {
  readonly id: string;
  readonly memorySpaceId: MemorySpaceId;
  readonly fingerprint: string;
  readonly reason: "cancelled" | "failed" | "cleared";
}
export interface VectorTaskFilters {
  readonly memorySpaceId?: MemorySpaceId;
  readonly tableId?: MemoryTableId;
  readonly statuses?: readonly VectorTaskStatus[];
  readonly source?: VectorTaskSource;
  readonly search?: string;
  readonly offset?: number;
  readonly limit?: number;
}
export interface VectorTaskPage {
  readonly items: readonly VectorTask[];
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly blocked: number;
}
export interface VectorTableSummary {
  readonly records: number;
  readonly ready: number;
  readonly stale: number;
  readonly errors: number;
  readonly empty: number;
  readonly queued: number;
}
export interface VectorSubmissionResult {
  readonly created: number;
  readonly reused: number;
  readonly promoted: number;
  readonly skipped: number;
}
export interface VectorPreview {
  readonly groupId: string;
  readonly groupName: string;
  readonly input: string;
  readonly fingerprint: string;
  readonly status: "ready" | "empty" | "too_long" | "unavailable" | "configuration_invalid";
  readonly error: string | null;
}
export interface VectorIndexRepository {
  saveTask(task: VectorTask): Promise<void>;
  getTask(id: string): Promise<VectorTask | undefined>;
  listTasks(): Promise<VectorTask[]>;
  deleteTasks(scope: VectorScope): Promise<void>;
  saveVector(vector: RecordVector): Promise<void>;
  getVector(id: string): Promise<RecordVector | undefined>;
  deleteVector(id: string): Promise<void>;
  listVectors(scope: VectorScope): Promise<RecordVector[]>;
  deleteVectors(scope: VectorScope): Promise<void>;
  saveSuppression(suppression: VectorSuppression): Promise<void>;
  getSuppression(id: string): Promise<VectorSuppression | undefined>;
  deleteSuppression(id: string): Promise<void>;
  deleteSuppressions(scope: VectorScope): Promise<void>;
  listSuppressions(): Promise<VectorSuppression[]>;
}
