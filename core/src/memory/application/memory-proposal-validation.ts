import {
  DomainError,
  type MemoryField,
  type MemoryRecord,
  type MemoryRecordPayload,
  type MemorySpaceId,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemoryFieldRepository } from "./ports/memory-field-repository.ts";
import type { MemoryRecordRepository } from "./ports/memory-record-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";
import { findMemoryRecordReferenceLocations } from "./memory-record-reference-validation.ts";
import { validatedMemoryRecordPayload } from "./memory-record-validation.ts";
import {
  isProposalTempId,
  memoryProposalError,
  type MemoryProposalError,
  type MemoryProposalOperation,
} from "./memory-proposal.ts";

/** 提案校验所需的领域访问端口：与提交（13）共用同一组 repository 端口。 */
export interface MemoryProposalPorts {
  readonly tables: MemoryTableRepository;
  readonly fields: MemoryFieldRepository;
  readonly records: MemoryRecordRepository;
}

interface SingleOperationCheck {
  readonly error: MemoryProposalError | undefined;
  readonly previous: MemoryRecord | undefined;
}

/**
 * 单操作即时校验（mutate 用，不查 revision、不做跨操作检查）：
 * 表存在且启用、create 需显示策略、字段值类型/必填/选项、
 * update/delete 目标记录存在。最多返回一个错误（首个失败原因）。
 */
export async function validateProposalOperation(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  operation: MemoryProposalOperation,
): Promise<readonly MemoryProposalError[]> {
  const result = await checkSingleOperation(ports, memorySpaceId, operation);
  return result.error ? [result.error] : [];
}

async function checkSingleOperation(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  operation: MemoryProposalOperation,
): Promise<SingleOperationCheck> {
  const table = await ports.tables.find(memorySpaceId, operation.tableId);
  if (!table) {
    return {
      error: memoryProposalError(operation, `表不存在（id ${operation.tableId}）`),
      previous: undefined,
    };
  }
  if (!table.enabled) {
    return {
      error: memoryProposalError(operation, `表「${table.name}」未启用，不能操作`),
      previous: undefined,
    };
  }
  const fields = await ports.fields.list(memorySpaceId, operation.tableId);
  try {
    if (operation.type === "create") {
      if (!table.displayStrategy) {
        return {
          error: memoryProposalError(operation, `表「${table.name}」未配置显示策略，无法创建记录`),
          previous: undefined,
        };
      }
      validatedMemoryRecordPayload(fields, operation.patch);
      return { error: undefined, previous: undefined };
    }
    const previous = await ports.records.find(memorySpaceId, operation.tableId, operation.recordId);
    if (!previous) {
      return {
        error: memoryProposalError(
          operation,
          `目标记录不存在（${operation.recordId}）；如需新增请使用 create`,
        ),
        previous: undefined,
      };
    }
    if (operation.type === "update") {
      validatedMemoryRecordPayload(fields, { ...previous.payload, ...operation.patch });
    }
    return { error: undefined, previous };
  } catch (error) {
    if (error instanceof DomainError) {
      return { error: memoryProposalError(operation, error.humanMsg), previous: undefined };
    }
    throw error;
  }
}

/**
 * 完整校验（proposal_preview / submit_proposal 用，查库）：
 * 单操作校验 + 跨操作一致性——tempId 唯一、引用目标存在且目标表匹配、
 * expectedRevision 匹配、删除安全（被删记录不得仍被最终状态引用）。
 * 收集全部错误（不中途停止），供预览展示与模型修正。
 */
export async function validateProposalOperations(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  operations: readonly MemoryProposalOperation[],
): Promise<readonly MemoryProposalError[]> {
  const errors: MemoryProposalError[] = [];
  const tables = await ports.tables.list(memorySpaceId);
  const fieldsByTableId = new Map(
    await Promise.all(
      tables.map(
        async (table) => [table.id, await ports.fields.list(memorySpaceId, table.id)] as const,
      ),
    ),
  );

  const createsByTempId = new Map<string, Extract<MemoryProposalOperation, { type: "create" }>>();
  const previousByKey = new Map<string, MemoryRecord>();
  for (const operation of operations) {
    const check = await checkSingleOperation(ports, memorySpaceId, operation);
    if (check.error) errors.push(check.error);
    if (operation.type === "create") {
      if (createsByTempId.has(operation.tempId)) {
        errors.push(memoryProposalError(operation, `临时 ID ${operation.tempId} 在本批次中重复`));
      } else {
        createsByTempId.set(operation.tempId, operation);
      }
    } else {
      if (check.previous) {
        previousByKey.set(recordKey(operation.tableId, operation.recordId), check.previous);
        if (check.previous.revisionId !== operation.expectedRevisionId) {
          errors.push(
            memoryProposalError(
              operation,
              `期望修订与当前不一致（当前 ${check.previous.revisionId}）；请重新查询后再操作`,
            ),
          );
        }
      }
    }
  }

  await collectReferenceErrors(
    ports,
    memorySpaceId,
    operations,
    fieldsByTableId,
    createsByTempId,
    previousByKey,
    errors,
  );
  await collectDeletionSafetyErrors(
    ports,
    memorySpaceId,
    operations,
    fieldsByTableId,
    previousByKey,
    errors,
  );
  return errors;
}

/** 引用目标校验：引用字段值必须是批次内同目标表的 tempId，或目标表中真实存在的记录 id。 */
async function collectReferenceErrors(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  operations: readonly MemoryProposalOperation[],
  fieldsByTableId: ReadonlyMap<MemoryTableId, readonly MemoryField[]>,
  createsByTempId: ReadonlyMap<string, Extract<MemoryProposalOperation, { type: "create" }>>,
  previousByKey: ReadonlyMap<string, MemoryRecord>,
  errors: MemoryProposalError[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.type === "delete") continue;
    const fields = fieldsByTableId.get(operation.tableId) ?? [];
    const payload =
      operation.type === "create"
        ? operation.patch
        : {
            ...previousByKey.get(recordKey(operation.tableId, operation.recordId))?.payload,
            ...operation.patch,
          };
    for (const field of fields) {
      if (!field.referenceTableId) continue;
      const value = payload[field.id];
      const recordIds = Array.isArray(value)
        ? value
        : value === null || value === undefined
          ? []
          : [value];
      for (const recordId of recordIds) {
        if (typeof recordId !== "string") continue;
        if (isProposalTempId(recordId)) {
          const target = createsByTempId.get(recordId);
          if (!target || target.tableId !== field.referenceTableId) {
            errors.push(
              memoryProposalError(
                operation,
                `字段「${field.name}」引用的临时 ID ${recordId} 不存在于目标表「${field.referenceTableId}」的批次创建中`,
              ),
            );
          }
        } else {
          const target = await ports.records.find(
            memorySpaceId,
            field.referenceTableId,
            recordId as MemoryRecord["id"],
          );
          if (!target) {
            errors.push(
              memoryProposalError(
                operation,
                `字段「${field.name}」引用的记录 ${recordId} 不存在于目标表`,
              ),
            );
          }
        }
      }
    }
  }
}

/** 删除安全：把批次应用到全空间记录副本后，被删记录不得仍被任何记录引用。 */
async function collectDeletionSafetyErrors(
  ports: MemoryProposalPorts,
  memorySpaceId: MemorySpaceId,
  operations: readonly MemoryProposalOperation[],
  fieldsByTableId: ReadonlyMap<MemoryTableId, readonly MemoryField[]>,
  previousByKey: ReadonlyMap<string, MemoryRecord>,
  errors: MemoryProposalError[],
): Promise<void> {
  const deleted = operations.filter((operation) => operation.type === "delete");
  if (deleted.length === 0) return;

  const tables = [...fieldsByTableId.keys()];
  const finalRecordsByTableId = new Map(
    await Promise.all(
      tables.map(async (tableId) => {
        const records = await ports.records.list(memorySpaceId, tableId);
        return [tableId, new Map(records.map((record) => [record.id, record] as const))] as const;
      }),
    ),
  );
  for (const operation of operations) {
    const records = finalRecordsByTableId.get(operation.tableId)!;
    if (operation.type === "delete") {
      records.delete(operation.recordId);
    } else if (operation.type === "update") {
      const previous = previousByKey.get(recordKey(operation.tableId, operation.recordId));
      if (previous)
        records.set(previous.id, {
          ...previous,
          payload: { ...previous.payload, ...operation.patch },
        });
    } else {
      records.set(operation.tempId as MemoryRecord["id"], {
        id: operation.tempId as MemoryRecord["id"],
        memorySpaceId,
        tableId: operation.tableId,
        payload: operation.patch as MemoryRecordPayload,
        fieldEvidence: {},
        displayText: "",
        source: { type: "manual" },
        revisionId: operation.tempId as MemoryRecord["revisionId"],
        revisionSource: "agent",
        createdAt: "",
        updatedAt: "",
      });
    }
  }
  const allRecords = [...finalRecordsByTableId.values()].flatMap((records) => [
    ...records.values(),
  ]);
  for (const operation of deleted) {
    const locations = findMemoryRecordReferenceLocations(
      allRecords,
      fieldsByTableId,
      operation.tableId,
      operation.recordId,
    );
    if (locations.length > 0) {
      errors.push(
        memoryProposalError(
          operation,
          `记录 ${operation.recordId} 仍被引用（${locations
            .map((location) => referenceText(fieldsByTableId, location))
            .join("、")}）；请先解除或转移引用`,
        ),
      );
    }
  }
}

function referenceText(
  fieldsByTableId: ReadonlyMap<MemoryTableId, readonly MemoryField[]>,
  location: {
    readonly tableId: MemoryTableId;
    readonly recordId: string;
    readonly fieldId: string;
  },
): string {
  const field = fieldsByTableId
    .get(location.tableId)
    ?.find((candidate) => candidate.id === location.fieldId);
  return field ? `${location.recordId}（字段「${field.name}」）` : `${location.recordId}`;
}

function recordKey(tableId: MemoryTableId, recordId: string): string {
  return `${tableId}:${recordId}`;
}
