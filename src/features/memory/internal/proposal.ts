import type {
  MemoryFieldId,
  MemoryRecordId,
  MemoryRevisionId,
  MemoryTableId,
} from "../domain/index.ts";

/** 批次内临时 ID 前缀：create 操作由引擎分配，引用字段可指向后续才创建的 create。 */
export const MEMORY_PROPOSAL_TEMP_ID_PREFIX = "tmp:";

export function isProposalTempId(value: string): boolean {
  return value.startsWith(MEMORY_PROPOSAL_TEMP_ID_PREFIX);
}

/**
 * 跨表提案操作（id 级，编译后）。
 * `externalId` 是调用方附加的纯数据标识（Agent 层为 mutationId），
 * 仅用于错误与预览结果回显定位，领域层不解释其含义。
 */
export type MemoryProposalOperation =
  | {
      readonly type: "create";
      readonly tableId: MemoryTableId;
      readonly tempId: string;
      readonly patch: Readonly<Record<MemoryFieldId, unknown>>;
      readonly externalId?: string;
    }
  | {
      readonly type: "update";
      readonly tableId: MemoryTableId;
      readonly recordId: MemoryRecordId;
      readonly expectedRevisionId: MemoryRevisionId;
      readonly patch: Readonly<Record<MemoryFieldId, unknown>>;
      readonly externalId?: string;
    }
  | {
      readonly type: "delete";
      readonly tableId: MemoryTableId;
      readonly recordId: MemoryRecordId;
      readonly expectedRevisionId: MemoryRevisionId;
      readonly externalId?: string;
    };

export type MemoryProposalCreateOperation = Extract<MemoryProposalOperation, { type: "create" }>;
export type MemoryProposalUpdateOperation = Extract<MemoryProposalOperation, { type: "update" }>;
export type MemoryProposalDeleteOperation = Extract<MemoryProposalOperation, { type: "delete" }>;

/** 统一 MutationBatch：提交（13）消费的冻结形状，只允许显式 create/update/delete。 */
export interface MemoryMutationBatch {
  readonly create: readonly MemoryProposalCreateOperation[];
  readonly update: readonly MemoryProposalUpdateOperation[];
  readonly delete: readonly MemoryProposalDeleteOperation[];
}

/** 提案校验错误：externalId 关联具体操作（Agent 层为 mutationId），undefined 表示整批级。 */
export interface MemoryProposalError {
  readonly externalId: string | undefined;
  readonly message: string;
}

export function memoryProposalError(
  operation: Pick<MemoryProposalOperation, "externalId"> | undefined,
  message: string,
): MemoryProposalError {
  return { externalId: operation?.externalId, message };
}

export function memoryProposalBatch(
  operations: readonly MemoryProposalOperation[],
): MemoryMutationBatch {
  return {
    create: operations.filter(
      (operation): operation is MemoryProposalCreateOperation => operation.type === "create",
    ),
    update: operations.filter(
      (operation): operation is MemoryProposalUpdateOperation => operation.type === "update",
    ),
    delete: operations.filter(
      (operation): operation is MemoryProposalDeleteOperation => operation.type === "delete",
    ),
  };
}
