import {
  type MemoryEvidence,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldValue,
  type MemoryRecordPayload,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemoryProposalPorts } from "./memory-proposal-validation.ts";
import { computeMemoryRecordDisplayText } from "./memory-record-display.ts";
import type { MemoryMutationBatch, MemoryProposalOperation } from "./memory-proposal.ts";

/** 处理块消息范围：任意闭区间（1-based），由外部传入。 */
export interface MemoryMessageRange {
  readonly from: number;
  readonly to: number;
}

/** 预览中的单字段变更（old/new 为提交前后值，null 表示无/清空）。 */
export interface MemoryProposalPreviewChange {
  readonly field: string;
  readonly old: MemoryFieldValue | null;
  readonly new: MemoryFieldValue | null;
}

/** 预览中的单个操作（表/字段均以 key 呈现，模型可直接阅读）。 */
export interface MemoryProposalPreviewOperation {
  readonly externalId: string | undefined;
  readonly op: "create" | "update" | "delete";
  readonly tableKey: string;
  readonly tableId: MemoryTableId;
  readonly tempId?: string;
  readonly recordId?: string;
  readonly display: string;
  readonly values?: Readonly<Record<string, MemoryFieldValue>>;
  readonly changes: readonly MemoryProposalPreviewChange[];
}

export interface MemoryProposalPreview {
  readonly tables: readonly string[];
  readonly operations: readonly MemoryProposalPreviewOperation[];
}

/** 冻结提案（submit 产物）：预览展开 + 统一 MutationBatch + 外部注入的消息范围与证据，供提交（13）消费。 */
export interface MemoryProposalSubmission {
  readonly messageRange: MemoryMessageRange;
  readonly evidence: readonly MemoryEvidence[];
  readonly operations: readonly MemoryProposalPreviewOperation[];
  readonly batch: MemoryMutationBatch;
}

/**
 * 差异预览：把操作展开为提交后形态（create 全新增、update 字段 diff、
 * delete 原样），display 按表显示策略计算。只读，无任何副作用。
 * 假定操作已经过校验器；记录缺失等异常情况以空值呈现（由校验错误兜底）。
 */
export async function previewProposal(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  operations: readonly MemoryProposalOperation[],
): Promise<MemoryProposalPreview> {
  const tables = await ports.tables.list(memorySpaceId);
  const tableById = new Map(tables.map((table) => [table.id, table]));
  const fieldsByTableId = new Map(
    await Promise.all(
      tables.map(
        async (table) => [table.id, await ports.fields.list(memorySpaceId, table.id)] as const,
      ),
    ),
  );

  const previewOperations: MemoryProposalPreviewOperation[] = [];
  const tableKeys: string[] = [];
  const seenTableKeys = new Set<string>();
  for (const operation of operations) {
    const table = tableById.get(operation.tableId);
    if (!table) continue;
    if (!seenTableKeys.has(table.key)) {
      seenTableKeys.add(table.key);
      tableKeys.push(table.key);
    }
    const fields = fieldsByTableId.get(operation.tableId) ?? [];
    previewOperations.push(await previewOperation(ports, memorySpaceId, table, fields, operation));
  }
  return { tables: tableKeys, operations: previewOperations };
}

async function previewOperation(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  table: MemoryTable,
  fields: readonly MemoryField[],
  operation: MemoryProposalOperation,
): Promise<MemoryProposalPreviewOperation> {
  const fieldKeyById = new Map(fields.map((field) => [field.id, field.key]));
  if (operation.type === "create") {
    const values = keyedPayload(operation.patch, fieldKeyById);
    const changes = Object.entries(operation.patch).map(([fieldId, value]) => ({
      field: fieldKeyById.get(fieldId as MemoryFieldId) ?? fieldId,
      old: null,
      new: value as MemoryFieldValue | null,
    }));
    return {
      externalId: operation.externalId,
      op: "create",
      tableKey: table.key,
      tableId: operation.tableId,
      tempId: operation.tempId,
      display: await previewDisplayText(ports, memorySpaceId, table, fields, operation.patch),
      values,
      changes,
    };
  }
  const previous = await ports.records.find(memorySpaceId, operation.tableId, operation.recordId);
  if (operation.type === "delete") {
    return {
      externalId: operation.externalId,
      op: "delete",
      tableKey: table.key,
      tableId: operation.tableId,
      recordId: operation.recordId,
      display: previous?.displayText ?? "",
      changes: [],
    };
  }
  const merged = { ...previous?.payload, ...operation.patch };
  const changes = Object.entries(operation.patch).map(([fieldId, value]) => ({
    field: fieldKeyById.get(fieldId as MemoryFieldId) ?? fieldId,
    old: (previous?.payload[fieldId as MemoryFieldId] ?? null) as MemoryFieldValue | null,
    new: value as MemoryFieldValue | null,
  }));
  return {
    externalId: operation.externalId,
    op: "update",
    tableKey: table.key,
    tableId: operation.tableId,
    recordId: operation.recordId,
    display: await previewDisplayText(ports, memorySpaceId, table, fields, merged),
    changes,
  };
}

/** 以字段 key 键控的 payload（模型可读）；不在摘要内的字段 id 保留原样。 */
function keyedPayload(
  payload: Readonly<Record<string, unknown>>,
  fieldKeyById: ReadonlyMap<string, string>,
): Readonly<Record<string, MemoryFieldValue>> {
  return Object.fromEntries(
    Object.entries(payload).map(([fieldId, value]) => [
      fieldKeyById.get(fieldId) ?? fieldId,
      value as MemoryFieldValue,
    ]),
  );
}

/**
 * 预览用显示文本：与提交共用同一领域规则（computeMemoryRecordDisplayText）；
 * 表未配置显示策略时校验器已报错，预览侧直接返回空串（display 无意义）。
 */
async function previewDisplayText(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  table: MemoryTable,
  fields: readonly MemoryField[],
  payload: Readonly<Record<string, unknown>>,
): Promise<string> {
  if (!table.displayStrategy) return "";
  return computeMemoryRecordDisplayText(
    ports.records,
    memorySpaceId,
    table,
    fields,
    payload as MemoryRecordPayload,
  );
}

/** 冻结提案（submit 产物）：展开预览 + 统一 MutationBatch + 外部注入的消息范围与证据。 */
export function memoryProposalSubmission(
  messageRange: MemoryMessageRange,
  evidence: readonly MemoryEvidence[],
  operations: readonly MemoryProposalPreviewOperation[],
  batch: MemoryMutationBatch,
): MemoryProposalSubmission {
  return { messageRange, evidence, operations, batch };
}
