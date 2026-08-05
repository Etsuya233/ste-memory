import type { MemoryProposalOperation, MemoryRecordId, MemoryRevisionId } from "../memory/index.ts";
import { findFieldInDigest, findTableInDigest, type MemorySpaceTableDigest } from "./digest.ts";
import type { ProposalState, ProposalStateOperationInput } from "./proposal-state.ts";

/**
 * 提案编译：把 State 的 key 级操作编译为领域层 id 级 MemoryProposalOperation。
 * 表/字段 key 在 mutate 时已经 digest 校验，这里找不到属于内部契约错误。
 * externalId 携带 mutationId，供领域层错误/预览原样回显。
 */
export function compileProposalOperations(
  digest: MemorySpaceTableDigest,
  state: ProposalState,
): readonly MemoryProposalOperation[] {
  return state.operations.map((operation) => compileProposalOperation(digest, operation));
}

export function compileProposalOperation(
  digest: MemorySpaceTableDigest,
  operation: ProposalStateOperationInput & { readonly mutationId?: string },
): MemoryProposalOperation {
  const table = findTableInDigest(digest, operation.tableKey);
  if (!table) {
    throw new Error(`内部错误：提案操作引用了未知表 key「${operation.tableKey}」`);
  }
  const patch = Object.fromEntries(
    Object.entries(operation.patch).map(([fieldKey, value]) => {
      const field = findFieldInDigest(table, fieldKey);
      if (!field) {
        throw new Error(
          `内部错误：提案操作引用了表「${table.key}」中未知的字段 key「${fieldKey}」`,
        );
      }
      return [field.id, value];
    }),
  );
  const externalId = operation.mutationId;
  if (operation.op === "create") {
    return {
      type: "create",
      tableId: table.id,
      tempId: operation.tempId!,
      patch,
      externalId,
    };
  }
  const base = {
    tableId: table.id,
    recordId: operation.recordId as MemoryRecordId,
    expectedRevisionId: operation.expectedRevisionId as MemoryRevisionId,
    externalId,
  };
  return operation.op === "update"
    ? { type: "update", ...base, patch }
    : { type: "delete", ...base };
}
