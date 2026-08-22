import {
  derivedDisplayTemplate,
  DomainError,
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
  type MemoryTableDisplayStrategy,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemoryFieldRepository } from "./ports/memory-field-repository.ts";
import type {
  MemoryRecordHistoryQuery,
  MemoryRecordRepository,
} from "./ports/memory-record-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";
import type { MemoryEvidenceRepository } from "./ports/memory-record-repository.ts";
import {
  projectStoredMemoryRecordPayload,
  validatedMemoryRecordPayload,
} from "./memory-record-validation.ts";
import {
  computeMemoryRecordDisplayText,
  createReadTimeDisplayTextResolver,
} from "./memory-record-display.ts";
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
    const resolvedEvidence = await this.resolveFieldEvidence(memorySpaceId, input.fieldEvidence);
    const fieldEvidence = resolvedEvidence.fieldEvidence;
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
      displayText: await computeMemoryRecordDisplayText(
        this.records,
        table.memorySpaceId,
        table,
        fields,
        payload,
      ),
      source,
      revisionId: this.createRevisionId(),
      revisionSource: "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.records.create(record, resolvedEvidence.createdEvidence);
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
    const resolvedEvidence = await this.resolveFieldEvidence(memorySpaceId, input.fieldEvidence);
    const submittedEvidence = resolvedEvidence.fieldEvidence;
    const fieldEvidence: Record<string, readonly MemoryEvidence[]> = {
      ...previous.fieldEvidence,
    };
    for (const fieldId of Object.keys(input.patch)) {
      fieldEvidence[fieldId] = submittedEvidence[fieldId] ?? [];
    }
    await this.mutate(
      memorySpaceId,
      {
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
      },
      resolvedEvidence.createdEvidence,
    );
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
    await this.mutate(
      memorySpaceId,
      {
        revisionSource,
        operations: [{ type: "delete", tableId, recordId: id, expectedRevisionId }],
      },
      [],
    );
    return true;
  }

  mutate(
    memorySpaceId: MemorySpaceId,
    input: MemoryRecordMutationBatchInput,
    evidence: readonly MemoryEvidence[],
  ): Promise<MemoryRecordMutationResult> {
    return commitMemoryRecordMutationBatch(
      {
        tables: this.tables,
        fields: this.fields,
        records: this.records,
        createId: this.createId,
        createHistoryId: this.createHistoryId,
        createRevisionId: this.createRevisionId,
        now: this.now,
        displayText: (table, fields, payload, resolveReference) =>
          computeMemoryRecordDisplayText(
            this.records,
            table.memorySpaceId,
            table,
            fields,
            payload,
            resolveReference,
          ),
      },
      memorySpaceId,
      input,
      evidence,
    );
  }

  async listHistory(
    memorySpaceId: MemorySpaceId,
    query: Omit<MemoryRecordHistoryQuery, "memorySpaceId">,
  ): Promise<readonly MemoryRecordHistory[]> {
    return this.records.listHistory({ ...query, memorySpaceId });
  }

  /**
   * 显示文本预览（ticket 10）：以「给定策略」计算一条 payload 的显示文本，只读不落库。
   * 策略合法性校验与 MemoryFieldService.setDisplayStrategy 同语义（违规抛
   * memory_table_display_strategy_invalid），保证 UI 预览不会因无效草稿策略崩溃
   * （computeMemoryRecordDisplayText 对模板中不存在的字段引用会直接抛 TypeError）。
   */
  async previewDisplayText(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    strategy: MemoryTableDisplayStrategy,
    payload: MemoryRecordPayload,
  ): Promise<string> {
    const table = await this.tables.find(memorySpaceId, tableId);
    if (!table) return "";
    const fields = await this.fields.list(memorySpaceId, tableId);
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    if (strategy.type === "field") {
      const field = fieldsById.get(strategy.fieldId);
      if (!field || field.type !== "short_text" || !field.enabled) {
        throw new DomainError({
          type: "memory_table_display_strategy_invalid",
          humanMsg: "显示字段必须是当前表中的短文本字段",
        });
      }
    } else {
      const template = derivedDisplayTemplate(strategy.template);
      if (template.fieldIds.some((fieldId) => !fieldsById.get(fieldId)?.enabled)) {
        throw new DomainError({
          type: "memory_table_display_strategy_invalid",
          humanMsg: "显示模板只能引用当前表中的字段",
        });
      }
    }
    return computeMemoryRecordDisplayText(
      this.records,
      memorySpaceId,
      { ...table, displayStrategy: strategy },
      fields,
      payload,
    );
  }

  async list(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    query: { readonly page: number; readonly pageSize: number; readonly search?: string },
  ): Promise<MemoryRecordPage | undefined> {
    const table = await this.tables.find(memorySpaceId, tableId);
    if (!table) return undefined;
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
    const listed = await this.records.list(memorySpaceId, tableId);
    // 读时显示文本：模板策略表按当前定义与目标记录重渲（存储 displayText 可能过期），
    // 搜索与返回值都用计算后的文本——「搜到的 = 看到的」；field 策略零额外查询。
    const resolveDisplay =
      table.displayStrategy?.type === "template"
        ? createReadTimeDisplayTextResolver({
            getTable: (candidateTableId) => this.tables.find(memorySpaceId, candidateTableId),
            getFields: (candidateTableId) => this.fields.list(memorySpaceId, candidateTableId),
            findRecord: (candidateTableId, recordId) =>
              this.records.find(memorySpaceId, candidateTableId, recordId as MemoryRecord["id"]),
          })
        : undefined;
    const records = resolveDisplay
      ? await Promise.all(
          listed.map(async (record) => ({ ...record, displayText: await resolveDisplay(record) })),
        )
      : listed;
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
    // 读路径宽松投影：字段定义漂移（删除字段/新增必填/选项变更/目标表删除）后存储
    // 的旧值仍可读，不抛错；写路径（create / update patch）仍严格校验
    return { ...record, payload: projectStoredMemoryRecordPayload(fields, record.payload) };
  }

  private async resolveFieldEvidence(
    memorySpaceId: MemorySpaceId,
    input: Readonly<Record<string, readonly MemoryEvidenceInput[]>> | undefined,
  ): Promise<{
    readonly fieldEvidence: MemoryFieldEvidence;
    readonly createdEvidence: readonly MemoryEvidence[];
  }> {
    if (!input) return { fieldEvidence: {}, createdEvidence: [] };
    if (!this.evidence || !this.createEvidenceId) throw new Error("字段证据需要配置证据存储");
    const result: Record<string, MemoryEvidence[]> = {};
    const createdEvidence: MemoryEvidence[] = [];
    const createdBySource = new Map<string, MemoryEvidence>();
    for (const [fieldId, entries] of Object.entries(input)) {
      result[fieldId] = [];
      for (const entry of entries) {
        const sourceKey = JSON.stringify([entry.source_type, entry.source_id]);
        const existing =
          createdBySource.get(sourceKey) ??
          (await this.evidence.findEvidence(memorySpaceId, entry.source_type, entry.source_id));
        if (existing && existing.storage_mode !== entry.storage_mode) {
          throw new DomainError({
            type: "memory_evidence_storage_mode_conflict",
            param: { sourceType: entry.source_type, sourceId: entry.source_id },
            humanMsg: "同一来源不能使用不同的证据存储模式",
          });
        }
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
        if (!existing) {
          createdBySource.set(sourceKey, evidence);
          createdEvidence.push(evidence);
        }
        result[fieldId]!.push(evidence);
      }
    }
    return { fieldEvidence: result, createdEvidence };
  }
}
