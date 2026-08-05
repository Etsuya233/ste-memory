import type { MemoryRevisionSource, MemorySpaceId } from "../domain/index.ts";
import type { MemoryProposalSubmission } from "./memory-proposal-preview.ts";
import {
  commitMemoryRecordMutationBatch,
  type MemoryRecordMutationContext,
  type MemoryRecordMutationOperation,
  type MemoryRecordMutationResult,
} from "./memory-record-mutations.ts";

/** Agent 填表写入的记录来源：来源处理产物（无具体时间/位置信息时留空）。 */
const AGENT_RECORD_SOURCE = { type: "source", sourceTime: null, sourceLocation: null } as const;

/**
 * 提交一个冻结提案（submit_proposal 产物）：把统一 MutationBatch 翻译为记录变更，
 * 以单个原子事务写入当前记录、旧快照历史、字段证据与 revision 元数据。
 * 与预览共用同一套领域规则；失败（校验/乐观锁/写库）整批回滚，无半批数据。
 */
export async function commitMemoryProposalBatch(
  context: MemoryRecordMutationContext,
  memorySpaceId: MemorySpaceId,
  submission: MemoryProposalSubmission,
  revisionSource: MemoryRevisionSource,
): Promise<MemoryRecordMutationResult> {
  const operations: MemoryRecordMutationOperation[] = [
    ...submission.batch.create.map((operation) => ({
      type: "create" as const,
      tableId: operation.tableId,
      tempId: operation.tempId,
      patch: operation.patch,
      source: AGENT_RECORD_SOURCE,
    })),
    ...submission.batch.update.map((operation) => ({
      type: "update" as const,
      tableId: operation.tableId,
      recordId: operation.recordId,
      expectedRevisionId: operation.expectedRevisionId,
      patch: operation.patch,
    })),
    ...submission.batch.delete.map((operation) => ({
      type: "delete" as const,
      tableId: operation.tableId,
      recordId: operation.recordId,
      expectedRevisionId: operation.expectedRevisionId,
    })),
  ];
  return commitMemoryRecordMutationBatch(
    context,
    memorySpaceId,
    { revisionSource, operations },
    submission.evidence,
  );
}
