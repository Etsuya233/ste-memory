import type {
  CreateMemoryFieldInput,
  MemoryFieldUpdateResult,
  UpdateMemoryFieldInput,
} from "../memory-field-service.ts";
import type {
  CreateMemoryRecordInput,
  MemoryRecordPage,
  UpdateMemoryRecordInput,
} from "../memory-record-service.ts";
import type { QueryRecordsInput, QueryRecordsPage } from "../memory-record-query-service.ts";
import type { MemoryRecordHistoryQuery } from "./memory-record-repository.ts";
import type { MemoryField, MemoryFieldId } from "../../domain/memory-field.ts";
import type {
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordId,
  MemoryRevisionId,
  MemoryRevisionSource,
} from "../../domain/memory-record.ts";
import type {
  MemoryTable,
  MemoryTableDisplayStrategy,
  MemoryTableId,
} from "../../domain/memory-table.ts";
import type { MemorySpace, MemorySpaceId } from "../../domain/memory-space.ts";
import type { CreateMemoryTableInput, UpdateMemoryTableInput } from "../memory-table-service.ts";

export interface MemoryTableUseCases {
  create(
    memorySpaceId: MemorySpaceId,
    input: CreateMemoryTableInput,
  ): Promise<MemoryTable | undefined>;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean>;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined>;
  list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]>;
  update(
    memorySpaceId: MemorySpaceId,
    id: MemoryTableId,
    input: UpdateMemoryTableInput,
  ): Promise<MemoryTable | undefined>;
}

export interface MemoryFieldUseCases {
  create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryFieldInput,
  ): Promise<MemoryField | undefined>;
  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): Promise<boolean>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined>;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]>;
  setDisplayStrategy(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    strategy: MemoryTableDisplayStrategy,
  ): Promise<MemoryTable | undefined>;
  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
    input: UpdateMemoryFieldInput,
  ): Promise<MemoryFieldUpdateResult | undefined>;
}

export interface MemoryRecordUseCases {
  create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryRecordInput,
  ): Promise<MemoryRecord | undefined>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
  ): Promise<MemoryRecord | undefined>;
  list(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    query: { readonly page: number; readonly pageSize: number; readonly search?: string },
  ): Promise<MemoryRecordPage | undefined>;
  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    input: UpdateMemoryRecordInput,
  ): Promise<MemoryRecord | undefined>;
  delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    expectedRevisionId: MemoryRevisionId,
    revisionSource: MemoryRevisionSource,
  ): Promise<boolean>;
  listHistory(
    memorySpaceId: MemorySpaceId,
    query: Omit<MemoryRecordHistoryQuery, "memorySpaceId">,
  ): Promise<readonly MemoryRecordHistory[]>;
}

export interface MemoryRecordQueryUseCases {
  query(memorySpaceId: MemorySpaceId, input: QueryRecordsInput): Promise<QueryRecordsPage>;
}

export interface MemorySpaceUseCases {
  create(name: string): Promise<MemorySpace>;
  delete(id: MemorySpaceId): Promise<boolean>;
  find(id: MemorySpaceId): Promise<MemorySpace | undefined>;
  list(): Promise<MemorySpace[]>;
  rename(id: MemorySpaceId, name: string): Promise<MemorySpace | undefined>;
}
