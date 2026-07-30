import {
  DomainError,
  type MemoryField,
  type MemoryFieldEvidence,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRecordPayload,
  type MemoryRevisionId,
  type MemoryRevisionSource,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemoryFieldRepository } from "./ports/memory-field-repository.ts";
import type {
  MemoryRecordMutation,
  MemoryRecordRepository,
} from "./ports/memory-record-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";
import {
  findMemoryRecordReferenceLocations,
  validateMemoryRecordReferences,
} from "./memory-record-reference-validation.ts";
import { validatedMemoryRecordPayload } from "./memory-record-validation.ts";

export type MemoryRecordMutationOperation =
  | {
      readonly type: "update";
      readonly tableId: MemoryTableId;
      readonly recordId: MemoryRecordId;
      readonly expectedRevisionId: MemoryRevisionId;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly fieldEvidence?: MemoryFieldEvidence;
    }
  | {
      readonly type: "delete";
      readonly tableId: MemoryTableId;
      readonly recordId: MemoryRecordId;
      readonly expectedRevisionId: MemoryRevisionId;
    };

export interface MemoryRecordMutationBatchInput {
  readonly revisionSource: MemoryRevisionSource;
  readonly operations: readonly MemoryRecordMutationOperation[];
}

export interface MemoryRecordMutationResult {
  readonly revisionId: MemoryRevisionId;
  readonly changed: number;
}

interface MemoryRecordMutationContext {
  readonly tables: MemoryTableRepository;
  readonly fields: MemoryFieldRepository;
  readonly records: MemoryRecordRepository;
  readonly createHistoryId: () => MemoryRecordHistoryId;
  readonly createRevisionId: () => MemoryRevisionId;
  readonly now: () => string;
  readonly displayText: (
    table: MemoryTable,
    fields: readonly MemoryField[],
    payload: MemoryRecordPayload,
  ) => Promise<string>;
}

export async function commitMemoryRecordMutationBatch(
  context: MemoryRecordMutationContext,
  memorySpaceId: MemorySpaceId,
  input: MemoryRecordMutationBatchInput,
): Promise<MemoryRecordMutationResult> {
  const revisionId = context.createRevisionId();
  const archivedAt = context.now();
  const mutations: MemoryRecordMutation[] = [];
  for (const operation of input.operations) {
    const previous = await context.records.find(
      memorySpaceId,
      operation.tableId,
      operation.recordId,
    );
    if (!previous) {
      throw new DomainError({
        type: "memory_record_not_found",
        humanMsg: "要变更的记忆记录不存在",
      });
    }
    if (previous.revisionId !== operation.expectedRevisionId) revisionConflict(previous.id);
    let current: MemoryRecord | undefined;
    if (operation.type === "update") {
      const fields = await context.fields.list(memorySpaceId, operation.tableId);
      const payload = validatedMemoryRecordPayload(fields, {
        ...previous.payload,
        ...operation.patch,
      });
      await validateMemoryRecordReferences(fields, payload, (tableId, recordId) =>
        context.records.find(memorySpaceId, tableId, recordId),
      );
      const table = (await context.tables.find(memorySpaceId, operation.tableId))!;
      const displayText = await context.displayText(table, fields, payload);
      if (
        JSON.stringify(payload) === JSON.stringify(previous.payload) &&
        JSON.stringify(operation.fieldEvidence ?? previous.fieldEvidence ?? {}) ===
          JSON.stringify(previous.fieldEvidence ?? {})
      )
        continue;
      current = {
        ...previous,
        payload,
        fieldEvidence: operation.fieldEvidence ?? previous.fieldEvidence ?? {},
        displayText,
        revisionId,
        revisionSource: input.revisionSource,
        updatedAt: archivedAt,
      };
    }
    mutations.push({
      previous,
      current,
      history: historySnapshot(
        context.createHistoryId(),
        previous,
        revisionId,
        input.revisionSource,
        archivedAt,
      ),
    });
  }
  await validateFinalReferences(context, memorySpaceId, mutations);
  if (mutations.length > 0 && !(await context.records.commit(mutations))) {
    revisionConflict(mutations[0]!.previous.id);
  }
  return { revisionId, changed: mutations.length };
}

async function validateFinalReferences(
  context: MemoryRecordMutationContext,
  memorySpaceId: MemorySpaceId,
  mutations: readonly MemoryRecordMutation[],
): Promise<void> {
  const tables = await context.tables.list(memorySpaceId);
  const fieldEntries = await Promise.all(
    tables.map(
      async (table) => [table.id, await context.fields.list(memorySpaceId, table.id)] as const,
    ),
  );
  const fieldsByTable = new Map(fieldEntries);
  const recordEntries = await Promise.all(
    tables.map(
      async (table) => [table.id, await context.records.list(memorySpaceId, table.id)] as const,
    ),
  );
  const finalRecords = new Map(
    recordEntries.map(
      ([tableId, records]) =>
        [tableId, new Map(records.map((record) => [record.id, record] as const))] as const,
    ),
  );
  for (const mutation of mutations) {
    const records = finalRecords.get(mutation.previous.tableId)!;
    if (mutation.current) records.set(mutation.previous.id, mutation.current);
    else records.delete(mutation.previous.id);
  }
  const records = [...finalRecords.values()].flatMap((recordsById) => [...recordsById.values()]);
  for (const mutation of mutations) {
    if (mutation.current) continue;
    const references = findMemoryRecordReferenceLocations(
      records,
      fieldsByTable,
      mutation.previous.tableId,
      mutation.previous.id,
    );
    if (references.length > 0) {
      throw new DomainError({
        type: "memory_record_referenced",
        param: { recordId: mutation.previous.id, references },
        humanMsg: "记忆记录仍被当前记录引用，请先解除或转移引用",
      });
    }
  }
  for (const mutation of mutations) {
    if (!mutation.current) continue;
    await validateMemoryRecordReferences(
      fieldsByTable.get(mutation.current.tableId)!,
      mutation.current.payload,
      async (tableId, recordId) => finalRecords.get(tableId)!.get(recordId),
    );
  }
}

function historySnapshot(
  id: MemoryRecordHistoryId,
  record: MemoryRecord,
  revisionId: MemoryRevisionId,
  revisionSource: MemoryRevisionSource,
  archivedAt: string,
): MemoryRecordHistory {
  return {
    id,
    recordId: record.id,
    memorySpaceId: record.memorySpaceId,
    tableId: record.tableId,
    payload: record.payload,
    fieldEvidence: record.fieldEvidence ?? {},
    displayText: record.displayText,
    source: record.source,
    previousRevisionId: record.revisionId,
    previousRevisionSource: record.revisionSource,
    revisionId,
    revisionSource,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt,
  };
}

function revisionConflict(recordId: MemoryRecordId): never {
  throw new DomainError({
    type: "memory_record_revision_conflict",
    param: { recordId },
    humanMsg: "记忆记录已被其他变更更新，请刷新后重试",
  });
}
