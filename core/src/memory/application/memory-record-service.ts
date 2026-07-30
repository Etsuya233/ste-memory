import {
  derivedDisplayTemplate,
  DomainError,
  type MemoryField,
  type MemoryEvidence,
  type MemoryEvidenceId,
  type MemoryEvidenceInput,
  type MemoryFieldEvidence,
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
import type { MemoryEvidenceRepository } from "./ports/memory-record-repository.ts";
import { validatedMemoryRecordPayload } from "./memory-record-validation.ts";
import { validateMemoryRecordReferences } from "./memory-record-reference-validation.ts";
import {
  commitMemoryRecordMutationBatch,
  type MemoryRecordMutationBatchInput,
  type MemoryRecordMutationResult,
} from "./memory-record-mutations.ts";
import type { MemoryRecordHistoryId } from "../domain/index.ts";

export interface CreateMemoryRecordInput {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source?: MemoryRecordSource;
  readonly fieldEvidence?: Readonly<Record<string, readonly MemoryEvidenceInput[]>>;
}

export interface UpdateMemoryRecordInput {
  readonly expectedRevisionId: MemoryRevisionId;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly revisionSource: MemoryRevisionSource;
  readonly fieldEvidence?: Readonly<Record<string, readonly MemoryEvidenceInput[]>>;
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
  private readonly evidence?: MemoryEvidenceRepository;
  private readonly createEvidenceId?: () => MemoryEvidenceId;

  constructor(
    tables: MemoryTableRepository,
    fields: MemoryFieldRepository,
    records: MemoryRecordRepository,
    createId: () => MemoryRecordId,
    createHistoryId: () => MemoryRecordHistoryId,
    createRevisionId: () => MemoryRevisionId,
    now: () => string,
    evidence?: MemoryEvidenceRepository,
    createEvidenceId?: () => MemoryEvidenceId,
  ) {
    this.tables = tables;
    this.fields = fields;
    this.records = records;
    this.createId = createId;
    this.createHistoryId = createHistoryId;
    this.createRevisionId = createRevisionId;
    this.now = now;
    this.evidence = evidence;
    this.createEvidenceId = createEvidenceId;
  }

  async create(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    input: CreateMemoryRecordInput,
  ): Promise<MemoryRecord | undefined> {
    const table = await this.tables.find(memorySpaceId, tableId);
    if (!table) return undefined;
    const fields = await this.fields.list(memorySpaceId, tableId);
    const payload = validatedMemoryRecordPayload(fields, input.payload);
    await validateMemoryRecordReferences(fields, payload, (targetTableId, recordId) =>
      this.records.find(memorySpaceId, targetTableId, recordId),
    );
    const fieldEvidence = await this.resolveFieldEvidence(memorySpaceId, input.fieldEvidence);
    const source =
      input.source ??
      (Object.keys(fieldEvidence).length > 0
        ? { type: "source" as const, sourceTime: null, sourceLocation: null }
        : { type: "manual" as const });
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
      fieldEvidence,
      displayText: await this.displayText(table, fields, payload),
      source,
      revisionId: this.createRevisionId(),
      revisionSource: "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.records.create(record);
    return record;
  }

  async find(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryRecordId) {
    const record = await this.records.find(memorySpaceId, tableId, id);
    if (!record) return undefined;
    return this.validatedRecord(record);
  }

  async update(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    input: UpdateMemoryRecordInput,
  ): Promise<MemoryRecord | undefined> {
    const previous = await this.records.find(memorySpaceId, tableId, id);
    if (!previous) return undefined;
    const submittedEvidence = await this.resolveFieldEvidence(memorySpaceId, input.fieldEvidence);
    const fieldEvidence: Record<string, readonly MemoryEvidence[]> = {
      ...(previous.fieldEvidence ?? {}),
    };
    for (const fieldId of Object.keys(input.patch)) {
      fieldEvidence[fieldId] = submittedEvidence[fieldId] ?? [];
    }
    await this.mutate(memorySpaceId, {
      revisionSource: input.revisionSource,
      operations: [
        {
          type: "update",
          tableId,
          recordId: id,
          expectedRevisionId: input.expectedRevisionId,
          patch: input.patch,
          fieldEvidence,
        },
      ],
    });
    return this.find(memorySpaceId, tableId, id);
  }

  async delete(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryRecordId,
    expectedRevisionId: MemoryRevisionId,
    revisionSource: MemoryRevisionSource,
  ): Promise<boolean> {
    if (!(await this.records.find(memorySpaceId, tableId, id))) return false;
    await this.mutate(memorySpaceId, {
      revisionSource,
      operations: [{ type: "delete", tableId, recordId: id, expectedRevisionId }],
    });
    return true;
  }

  mutate(
    memorySpaceId: MemorySpaceId,
    input: MemoryRecordMutationBatchInput,
  ): Promise<MemoryRecordMutationResult> {
    return commitMemoryRecordMutationBatch(
      {
        tables: this.tables,
        fields: this.fields,
        records: this.records,
        createHistoryId: this.createHistoryId,
        createRevisionId: this.createRevisionId,
        now: this.now,
        displayText: (table, fields, payload) => this.displayText(table, fields, payload),
      },
      memorySpaceId,
      input,
    );
  }

  async listHistory(
    memorySpaceId: MemorySpaceId,
    query: Omit<MemoryRecordHistoryQuery, "memorySpaceId">,
  ): Promise<readonly MemoryRecordHistory[]> {
    return this.records.listHistory({ ...query, memorySpaceId });
  }

  async list(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    query: { readonly page: number; readonly pageSize: number; readonly search?: string },
  ): Promise<MemoryRecordPage | undefined> {
    if (!(await this.tables.find(memorySpaceId, tableId))) return undefined;
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
    const records = await this.records.list(memorySpaceId, tableId);
    const matches = (
      await Promise.all(records.map((record) => this.validatedRecord(record)))
    ).filter((record) => {
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

  private async validatedRecord(record: MemoryRecord): Promise<MemoryRecord> {
    const fields = await this.fields.list(record.memorySpaceId, record.tableId);
    const payload = validatedMemoryRecordPayload(fields, record.payload);
    await validateMemoryRecordReferences(fields, payload, (targetTableId, recordId) =>
      this.records.find(record.memorySpaceId, targetTableId, recordId),
    );
    return { ...record, payload, fieldEvidence: record.fieldEvidence ?? {} };
  }

  private async resolveFieldEvidence(
    memorySpaceId: MemorySpaceId,
    input: Readonly<Record<string, readonly MemoryEvidenceInput[]>> | undefined,
  ): Promise<MemoryFieldEvidence> {
    if (!input) return {};
    if (!this.evidence || !this.createEvidenceId) throw new Error("字段证据需要配置证据存储");
    const result: Record<string, MemoryEvidence[]> = {};
    for (const [fieldId, entries] of Object.entries(input)) {
      result[fieldId] = [];
      for (const entry of entries) {
        const existing = await this.evidence.findEvidence(
          memorySpaceId,
          entry.source_type,
          entry.source_id,
        );
        const evidence: MemoryEvidence =
          existing ??
          (entry.storage_mode === "snapshot"
            ? {
                evidence_id: this.createEvidenceId(),
                source_type: entry.source_type,
                source_id: entry.source_id,
                storage_mode: "snapshot",
                content: entry.content,
                extraProps: entry.extraProps ?? {},
              }
            : {
                evidence_id: this.createEvidenceId(),
                source_type: entry.source_type,
                source_id: entry.source_id,
                storage_mode: "reference",
                extraProps: entry.extraProps ?? {},
              });
        if (!existing) await this.evidence.createEvidence(memorySpaceId, evidence);
        result[fieldId]!.push(evidence);
      }
    }
    return result;
  }

  private async displayText(
    table: MemoryTable,
    fields: readonly MemoryField[],
    payload: MemoryRecordPayload,
  ): Promise<string> {
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
    let text = template.template;
    for (const fieldId of template.fieldIds) {
      const field = fields.find((item) => item.id === fieldId)!;
      const value = payload[fieldId];
      const values = Array.isArray(value)
        ? value
        : value === null || value === undefined
          ? []
          : [value];
      const rendered = field.referenceTableId
        ? (
            await Promise.all(
              values.map((id) =>
                this.records.find(
                  table.memorySpaceId,
                  field.referenceTableId!,
                  id as MemoryRecordId,
                ),
              ),
            )
          )
            .map((record) => record!.displayText)
            .join(", ")
        : values.join(", ");
      text = text.replaceAll(`{${fieldId}}`, rendered);
    }
    return text;
  }
}
