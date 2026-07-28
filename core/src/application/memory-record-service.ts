import {
  derivedDisplayTemplate,
  DomainError,
  type MemoryField,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordId,
  type MemoryRecordPayload,
  type MemoryRecordSource,
  type MemoryRevisionId,
  type MemoryRevisionSource,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemoryFieldRepository } from "./ports/memory-field-repository.ts";
import type {
  MemoryRecordHistoryQuery,
  MemoryRecordRepository,
} from "./ports/memory-record-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";
import { validatedMemoryRecordPayload } from "./memory-record-validation.ts";
import {
  commitMemoryRecordMutationBatch,
  type MemoryRecordMutationBatchInput,
  type MemoryRecordMutationResult,
} from "./memory-record-mutations.ts";
import type { MemoryRecordHistoryId } from "../domain/index.ts";

export interface CreateMemoryRecordInput {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source?: MemoryRecordSource;
}

export interface UpdateMemoryRecordInput {
  readonly expectedRevisionId: MemoryRevisionId;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly revisionSource: MemoryRevisionSource;
}

export interface MemoryRecordPage {
  readonly records: readonly MemoryRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export class MemoryRecordService {
  private readonly tables: MemoryTableRepository;
  private readonly fields: MemoryFieldRepository;
  private readonly records: MemoryRecordRepository;
  private readonly createId: () => MemoryRecordId;
  private readonly createHistoryId: () => MemoryRecordHistoryId;
  private readonly createRevisionId: () => MemoryRevisionId;
  private readonly now: () => string;

  constructor(
    tables: MemoryTableRepository,
    fields: MemoryFieldRepository,
    records: MemoryRecordRepository,
    createId: () => MemoryRecordId,
    createHistoryId: () => MemoryRecordHistoryId,
    createRevisionId: () => MemoryRevisionId,
    now: () => string,
  ) {
    this.tables = tables;
    this.fields = fields;
    this.records = records;
    this.createId = createId;
    this.createHistoryId = createHistoryId;
    this.createRevisionId = createRevisionId;
    this.now = now;
  }

  create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryRecordInput,
  ): MemoryRecord | undefined {
    const table = this.tables.find(memorySpaceId, tableId);
    if (!table) return undefined;
    const fields = this.fields.list(memorySpaceId, tableId);
    const payload = validatedMemoryRecordPayload(fields, input.payload);
    this.validateReferences(memorySpaceId, fields, payload);
    const source = input.source ?? { type: "manual" };
    if (
      source.type === "source" &&
      source.sourceTime !== null &&
      Number.isNaN(Date.parse(source.sourceTime))
    ) {
      throw new DomainError({
        type: "memory_record_source_invalid",
        humanMsg: "来源时间必须是有效的日期时间",
      });
    }
    const timestamp = this.now();
    const record: MemoryRecord = {
      id: this.createId(),
      memorySpaceId,
      tableId,
      payload,
      displayText: this.displayText(table, fields, payload),
      source,
      revisionId: this.createRevisionId(),
      revisionSource: "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.records.create(record);
    return record;
  }

  find(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryRecordId) {
    const record = this.records.find(memorySpaceId, tableId, id);
    if (!record) return undefined;
    return this.validatedRecord(record);
  }

  update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    input: UpdateMemoryRecordInput,
  ): MemoryRecord | undefined {
    if (!this.records.find(memorySpaceId, tableId, id)) return undefined;
    this.mutate(memorySpaceId, {
      revisionSource: input.revisionSource,
      operations: [
        {
          type: "update",
          tableId,
          recordId: id,
          expectedRevisionId: input.expectedRevisionId,
          patch: input.patch,
        },
      ],
    });
    return this.find(memorySpaceId, tableId, id);
  }

  delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    expectedRevisionId: MemoryRevisionId,
    revisionSource: MemoryRevisionSource,
  ): boolean {
    if (!this.records.find(memorySpaceId, tableId, id)) return false;
    this.mutate(memorySpaceId, {
      revisionSource,
      operations: [{ type: "delete", tableId, recordId: id, expectedRevisionId }],
    });
    return true;
  }

  mutate(
    memorySpaceId: MemorySpaceId,
    input: MemoryRecordMutationBatchInput,
  ): MemoryRecordMutationResult {
    return commitMemoryRecordMutationBatch(
      {
        tables: this.tables,
        fields: this.fields,
        records: this.records,
        createHistoryId: this.createHistoryId,
        createRevisionId: this.createRevisionId,
        now: this.now,
        displayText: (table, fields, payload) => this.displayText(table, fields, payload),
        validateReferences: (spaceId, fields, payload) =>
          this.validateReferences(spaceId, fields, payload),
      },
      memorySpaceId,
      input,
    );
  }

  listHistory(
    memorySpaceId: MemorySpaceId,
    query: Omit<MemoryRecordHistoryQuery, "memorySpaceId">,
  ): readonly MemoryRecordHistory[] {
    return this.records.listHistory({ ...query, memorySpaceId });
  }

  list(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    query: { readonly page: number; readonly pageSize: number; readonly search?: string },
  ): MemoryRecordPage | undefined {
    if (!this.tables.find(memorySpaceId, tableId)) return undefined;
    if (
      !Number.isInteger(query.page) ||
      query.page < 1 ||
      !Number.isInteger(query.pageSize) ||
      query.pageSize < 1 ||
      query.pageSize > 100
    ) {
      throw new DomainError({ type: "memory_record_paging_invalid", humanMsg: "分页参数无效" });
    }
    const search = query.search?.trim().toLocaleLowerCase();
    const matches = this.records
      .list(memorySpaceId, tableId)
      .map((record) => this.validatedRecord(record))
      .filter((record) => {
        if (!search) return true;
        return [record.id, record.displayText, ...Object.values(record.payload)]
          .flatMap((value) => (Array.isArray(value) ? value : [value]))
          .some((value) => String(value).toLocaleLowerCase().includes(search));
      });
    const offset = (query.page - 1) * query.pageSize;
    return {
      records: matches.slice(offset, offset + query.pageSize),
      page: query.page,
      pageSize: query.pageSize,
      total: matches.length,
      totalPages: Math.ceil(matches.length / query.pageSize),
    };
  }

  private validatedRecord(record: MemoryRecord): MemoryRecord {
    const fields = this.fields.list(record.memorySpaceId, record.tableId);
    const payload = validatedMemoryRecordPayload(fields, record.payload);
    this.validateReferences(record.memorySpaceId, fields, payload);
    return { ...record, payload };
  }

  private validateReferences(
    memorySpaceId: MemorySpaceId,
    fields: readonly MemoryField[],
    payload: MemoryRecordPayload,
  ): void {
    for (const field of fields) {
      if (!field.referenceTableId) continue;
      const value = payload[field.id];
      const ids = Array.isArray(value)
        ? value
        : value === null || value === undefined
          ? []
          : [value];
      if (
        ids.some(
          (id) =>
            typeof id !== "string" ||
            !this.records.find(memorySpaceId, field.referenceTableId!, id as MemoryRecordId),
        )
      ) {
        throw new DomainError({
          type: "memory_record_reference_invalid",
          param: { fieldId: field.id },
          humanMsg: `字段“${field.name}”引用的记录不存在于目标表格`,
        });
      }
    }
  }

  private displayText(
    table: MemoryTable,
    fields: readonly MemoryField[],
    payload: MemoryRecordPayload,
  ): string {
    if (!table.displayStrategy) {
      throw new DomainError({
        type: "memory_record_display_strategy_missing",
        humanMsg: "创建记录前必须配置表格显示策略",
      });
    }
    if (table.displayStrategy.type === "field") {
      return String(payload[table.displayStrategy.fieldId] ?? "");
    }
    const template = derivedDisplayTemplate(table.displayStrategy.template);
    return template.fieldIds.reduce((text, fieldId) => {
      const field = fields.find((item) => item.id === fieldId)!;
      const value = payload[fieldId];
      const values = Array.isArray(value)
        ? value
        : value === null || value === undefined
          ? []
          : [value];
      const rendered = field.referenceTableId
        ? values
            .map(
              (id) =>
                this.records.find(
                  table.memorySpaceId,
                  field.referenceTableId!,
                  id as MemoryRecordId,
                )!.displayText,
            )
            .join(", ")
        : values.join(", ");
      return text.replaceAll(`{${fieldId}}`, rendered);
    }, template.template);
  }
}
