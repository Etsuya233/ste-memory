import {
  DomainError,
  type MemoryField,
  type MemoryFieldId,
  type MemoryEvidence,
  type MemoryFieldEvidence,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRecordHistoryId,
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
  MemoryRecordMutation,
  MemoryRecordRepository,
} from "./ports/memory-record-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";
import { isProposalTempId } from "./memory-proposal.ts";
import {
  findMemoryRecordReferenceLocations,
  validateMemoryRecordReferences,
} from "./memory-record-reference-validation.ts";
import {
  projectStoredMemoryRecordPayload,
  validateMemoryRecordPatch,
  validatedMemoryRecordPayload,
} from "./memory-record-validation.ts";
import {
  createBatchReferenceResolver,
  type MemoryRecordDisplayTextResolver,
} from "./memory-record-display.ts";

export type MemoryRecordMutationOperation =
  | {
      readonly type: "create";
      readonly tableId: MemoryTableId;
      /** 批内临时 ID（引用字段可用 tmp: 前缀指向它），提交时解析为真实记录 ID。 */
      readonly tempId: string;
      readonly patch: Readonly<Record<string, unknown>>;
      readonly fieldEvidence?: MemoryFieldEvidence;
      /** 新记录来源；缺省时按字段证据推断（有字段证据 = source，否则 manual）。 */
      readonly source?: MemoryRecordSource;
    }
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

export interface MemoryRecordMutationContext {
  readonly tables: MemoryTableRepository;
  readonly fields: MemoryFieldRepository;
  readonly records: MemoryRecordRepository;
  readonly createId: () => MemoryRecordId;
  readonly createHistoryId: () => MemoryRecordHistoryId;
  readonly createRevisionId: () => MemoryRevisionId;
  readonly now: () => string;
  /**
   * 显示文本计算（领域规则由宿主接入 computeMemoryRecordDisplayText）。
   * resolveReference 必传：提交批次内新建、尚未落库的记录由批次感知解析器解析
   * （不传会退化为只查仓库，同批新建的引用目标渲染为空）。
   */
  readonly displayText: (
    table: MemoryTable,
    fields: readonly MemoryField[],
    payload: MemoryRecordPayload,
    resolveReference: MemoryRecordDisplayTextResolver,
  ) => Promise<string>;
}

/**
 * 原子提交一批记录变更：create/update/delete 共享同一修订身份，统一写入
 * 当前记录、旧状态历史与字段证据。任何一步失败（校验、乐观锁、写库）整批回滚。
 */
export async function commitMemoryRecordMutationBatch(
  context: MemoryRecordMutationContext,
  memorySpaceId: MemorySpaceId,
  input: MemoryRecordMutationBatchInput,
  evidence: readonly MemoryEvidence[],
): Promise<MemoryRecordMutationResult> {
  const revisionId = context.createRevisionId();
  const archivedAt = context.now();

  // 批内临时 ID 解析：create 操作由引擎分配真实 ID，引用字段的 tmp: 值提交时改写。
  const tempIdToRecordId = new Map<string, MemoryRecordId>();
  for (const operation of input.operations) {
    if (operation.type === "create") tempIdToRecordId.set(operation.tempId, context.createId());
  }

  // 批内 create 的待落库形态预计算（显示文本引用解析与 mutation 构建共用）：
  // 引用解析器能看到整批新建记录，displayText 渲染不再因「同批记录尚未落库」而空白。
  const pendingCreates: PendingCreate[] = [];
  for (const operation of input.operations) {
    if (operation.type !== "create") continue;
    const table = (await context.tables.find(memorySpaceId, operation.tableId))!;
    const fields = await context.fields.list(memorySpaceId, operation.tableId);
    const recordId = tempIdToRecordId.get(operation.tempId);
    if (!recordId) {
      throw new DomainError({
        type: "memory_record_reference_invalid",
        param: { fieldId: operation.tempId },
        humanMsg: `批内临时 ID ${operation.tempId} 不存在`,
      });
    }
    pendingCreates.push({
      operation,
      recordId,
      table,
      fields,
      payload: validatedMemoryRecordPayload(
        fields,
        resolveTempReferences(fields, operation.patch, tempIdToRecordId),
      ),
    });
  }
  const pendingByTempId = new Map(
    pendingCreates.map((item) => [item.operation.tempId, item] as const),
  );
  const resolveReference = createBatchReferenceResolver({
    pending: pendingCreates.map((item) => ({
      id: item.recordId,
      table: item.table,
      fields: item.fields,
      payload: item.payload,
    })),
    fallback: async (tableId, recordId) =>
      (await context.records.find(memorySpaceId, tableId, recordId as MemoryRecord["id"]))
        ?.displayText ?? "",
    compute: async (record, resolve) => {
      try {
        return await context.displayText(record.table, record.fields, record.payload, resolve);
      } catch {
        return ""; // 定义漂移（策略引用已删字段）：批内按未找到渲染空串，不阻断提交
      }
    },
  });

  const mutations: MemoryRecordMutation[] = [];
  for (const operation of input.operations) {
    if (operation.type === "create") {
      mutations.push(
        await buildCreateMutation(
          context,
          memorySpaceId,
          pendingByTempId.get(operation.tempId)!,
          revisionId,
          archivedAt,
          input.revisionSource,
          resolveReference,
        ),
      );
      continue;
    }
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
    let patchPayload: MemoryRecordPayload | undefined;
    if (operation.type === "update") {
      const fields = await context.fields.list(memorySpaceId, operation.tableId);
      const patch = resolveTempReferences(fields, operation.patch, tempIdToRecordId);
      // patch 严格校验（只校验本次写入的键）；与读路径宽松投影后的旧值合并——
      // 字段定义漂移（删除字段/新增必填/选项变更）不阻断无关字段的编辑
      patchPayload = validateMemoryRecordPatch(fields, patch);
      const payload = {
        ...projectStoredMemoryRecordPayload(fields, previous.payload),
        ...patchPayload,
      };
      const table = (await context.tables.find(memorySpaceId, operation.tableId))!;
      let displayText: string;
      try {
        displayText = await context.displayText(table, fields, payload, resolveReference);
      } catch {
        // 定义漂移（显示策略引用的字段不在当前字段集）：保留既有显示文本，不阻断更新
        displayText = previous.displayText;
      }
      if (
        JSON.stringify(payload) === JSON.stringify(previous.payload) &&
        JSON.stringify(operation.fieldEvidence ?? previous.fieldEvidence) ===
          JSON.stringify(previous.fieldEvidence)
      )
        continue;
      current = {
        ...previous,
        payload,
        fieldEvidence: operation.fieldEvidence ?? previous.fieldEvidence,
        displayText,
        revisionId,
        revisionSource: input.revisionSource,
        updatedAt: archivedAt,
      };
    }
    mutations.push({
      kind: "replace",
      previous,
      current,
      patchPayload: operation.type === "update" ? patchPayload : undefined,
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
  if (mutations.length > 0 && !(await context.records.commit(mutations, evidence))) {
    const first = mutations[0]!;
    revisionConflict(first.kind === "create" ? first.current.id : first.previous.id);
  }
  return { revisionId, changed: mutations.length };
}

async function buildCreateMutation(
  context: MemoryRecordMutationContext,
  memorySpaceId: MemorySpaceId,
  pending: PendingCreate,
  revisionId: MemoryRevisionId,
  archivedAt: string,
  revisionSource: MemoryRevisionSource,
  resolveReference: MemoryRecordDisplayTextResolver,
): Promise<MemoryRecordMutation> {
  const { operation, recordId, table, fields, payload } = pending;
  const fieldEvidence = operation.fieldEvidence ?? {};
  return {
    kind: "create",
    current: {
      id: recordId,
      memorySpaceId,
      tableId: operation.tableId,
      payload,
      fieldEvidence,
      displayText: await buildCreateDisplayText(
        context,
        memorySpaceId,
        table,
        fields,
        payload,
        resolveReference,
      ),
      source:
        operation.source ??
        (Object.keys(fieldEvidence).length > 0
          ? { type: "source", sourceTime: null, sourceLocation: null }
          : { type: "manual" }),
      revisionId,
      revisionSource,
      createdAt: archivedAt,
      updatedAt: archivedAt,
    },
  };
}

/** 新记录的存储显示文本：定义漂移（策略引用已删字段）时回退空串，不阻断创建。 */
async function buildCreateDisplayText(
  context: MemoryRecordMutationContext,
  memorySpaceId: MemorySpaceId,
  table: MemoryTable,
  fields: readonly MemoryField[],
  payload: MemoryRecordPayload,
  resolveReference: MemoryRecordDisplayTextResolver,
): Promise<string> {
  try {
    return await context.displayText(table, fields, payload, resolveReference);
  } catch {
    return "";
  }
}

/** 批内 create 的已编译形态：表/字段/解析后 payload 预计算一次，mutation 构建与引用解析共用。 */
interface PendingCreate {
  readonly operation: Extract<MemoryRecordMutationOperation, { type: "create" }>;
  readonly recordId: MemoryRecordId;
  readonly table: MemoryTable;
  readonly fields: readonly MemoryField[];
  readonly payload: MemoryRecordPayload;
}

/**
 * 把引用字段中的批内临时 ID（tmp: 前缀）改写为真实记录 ID；
 * 单引用为字符串、多引用为字符串数组，其余字段原样保留。
 */
function resolveTempReferences(
  fields: readonly MemoryField[],
  patch: Readonly<Record<string, unknown>>,
  tempIdToRecordId: ReadonlyMap<string, MemoryRecordId>,
): Readonly<Record<string, unknown>> {
  const referenceFieldIds = new Set(
    fields.filter((field) => field.referenceTableId !== null).map((field) => field.id),
  );
  let rewritten: Record<string, unknown> | undefined;
  for (const [fieldId, value] of Object.entries(patch)) {
    if (!referenceFieldIds.has(fieldId as MemoryFieldId)) continue;
    const resolved = resolveTempReferenceValue(value, tempIdToRecordId, fieldId);
    if (resolved !== value) {
      rewritten ??= { ...patch };
      rewritten[fieldId] = resolved;
    }
  }
  return rewritten ?? patch;
}

function resolveTempReferenceValue(
  value: unknown,
  tempIdToRecordId: ReadonlyMap<string, MemoryRecordId>,
  fieldId: string,
): unknown {
  const resolveOne = (candidate: unknown): unknown => {
    if (typeof candidate !== "string" || !isProposalTempId(candidate)) return candidate;
    const recordId = tempIdToRecordId.get(candidate);
    if (!recordId) {
      throw new DomainError({
        type: "memory_record_reference_invalid",
        param: { fieldId },
        humanMsg: `批内临时 ID ${candidate} 不存在`,
      });
    }
    return recordId;
  };
  if (Array.isArray(value)) return value.map(resolveOne);
  return resolveOne(value);
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
    if (mutation.kind === "create") {
      finalRecords.get(mutation.current.tableId)!.set(mutation.current.id, mutation.current);
      continue;
    }
    const records = finalRecords.get(mutation.previous.tableId)!;
    if (mutation.current) records.set(mutation.previous.id, mutation.current);
    else records.delete(mutation.previous.id);
  }
  const records = [...finalRecords.values()].flatMap((recordsById) => [...recordsById.values()]);
  for (const mutation of mutations) {
    if (mutation.kind !== "replace" || mutation.current) continue;
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
    if (mutation.kind === "replace" && !mutation.current) continue;
    const current = mutation.current!;
    // update 只校验本次写入键的引用（patchPayload）；未改动的拖尾引用由读路径宽松
    // 投影容忍，不阻断无关字段的编辑。create / 全量合并路径仍校验完整 payload。
    const payload =
      mutation.kind === "replace" && mutation.patchPayload
        ? mutation.patchPayload
        : current.payload;
    await validateMemoryRecordReferences(
      fieldsByTable.get(current.tableId)!,
      payload,
      // 目标表已删时查找返回 undefined → validateMemoryRecordReferences 抛
      // memory_record_reference_invalid（DomainError），不裸 TypeError
      async (tableId, recordId) => finalRecords.get(tableId)?.get(recordId),
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
    fieldEvidence: record.fieldEvidence,
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
