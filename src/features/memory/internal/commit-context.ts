import type { MemoryRecordHistoryId, MemoryRecordId, MemoryRevisionId } from "../domain/index.ts";
import type { MemoryFieldRepository } from "../ports/memory-field-repository.ts";
import type { MemoryRecordRepository } from "../ports/memory-record-repository.ts";
import type { MemoryTableRepository } from "../ports/memory-table-repository.ts";
import type { MemoryRecordMutationContext } from "./record-mutations.ts";
import { computeMemoryRecordDisplayText } from "./record-display.ts";

/**
 * 记忆提交上下文工厂：把 id 生成、时钟与显示文本计算等提交细节收在 Memory
 * 内部，宿主（runtime）只需注入持久化仓库与 id 工厂。填表/问答/手动编辑
 * 共用同一份上下文，规则一致。
 */
export interface MemoryCommitContextOptions {
  readonly tables: MemoryTableRepository;
  readonly fields: MemoryFieldRepository;
  readonly records: MemoryRecordRepository;
  readonly createId: () => MemoryRecordId;
  readonly createHistoryId: () => MemoryRecordHistoryId;
  readonly createRevisionId: () => MemoryRevisionId;
  readonly now: () => string;
}

export function createMemoryCommitContext(
  options: MemoryCommitContextOptions,
): MemoryRecordMutationContext {
  return {
    tables: options.tables,
    fields: options.fields,
    records: options.records,
    createId: options.createId,
    createHistoryId: options.createHistoryId,
    createRevisionId: options.createRevisionId,
    now: options.now,
    displayText: (table, fieldList, payload, resolveReference) =>
      computeMemoryRecordDisplayText(
        options.records,
        table.memorySpaceId,
        table,
        fieldList,
        payload,
        resolveReference,
      ),
  };
}
