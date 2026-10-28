/**
 * Memory 公开入口：其他功能与 UI 只从这里使用 Memory。
 *
 * 导出面 = 完整操作（空间/表格/字段/记录/查询/提案提交与预览）+ 公共领域类型
 * + 持久化接口（repository ports）。内部步骤（校验、修订、历史写入、
 * 记录提交中的校验、修订与历史写入只通过记录服务的完整操作执行。
 */
export type { MemorySpaceReader } from "./ports/memory-space-reader.ts";
export { SYSTEM_TABLE_TEMPLATES } from "./system-tables/index.ts";
export type {
  FieldTemplate,
  SystemMemoryTableKey,
  TableTemplate,
  TableTemplateDisplayStrategy,
} from "./system-tables/index.ts";
export { MemorySpaceService } from "./space-service.ts";
export type { MemorySpaceRepository } from "./ports/memory-space-repository.ts";
export { MemoryTableService } from "./table-service.ts";
export type { CreateMemoryTableInput, UpdateMemoryTableInput } from "./table-service.ts";
export type { MemoryTableRepository } from "./ports/memory-table-repository.ts";
export { MemoryFieldService } from "./field-service.ts";
export type {
  CreateMemoryFieldInput,
  MemoryFieldUpdateResult,
  UpdateMemoryFieldInput,
} from "./field-service.ts";
export type { MemoryFieldRepository } from "./ports/memory-field-repository.ts";
export { MemoryRecordService } from "./record-writer.ts";
export { DEFAULT_RECORD_LIST_ORDER, isRecordListSortField } from "./record-list-order.ts";
export type { MemoryRecordListOrder } from "./record-list-order.ts";
export type {
  CreateMemoryRecordInput,
  MemoryRecordPage,
  UpdateMemoryRecordInput,
} from "./record-writer.ts";
export { MemoryRecordQueryService } from "./record-query.ts";
export type { MemoryRecordQueryExecutor } from "./record-query.ts";
export type {
  QueryRecordFieldId,
  QueryRecordOperator,
  QueryRecordSystemFieldId,
  QueryRecordsCondition,
  QueryRecordsInput,
  QueryRecordsPage,
} from "./record-query-contract.ts";
export { createReadTimeDisplayTextResolver } from "./internal/record-display.ts";
export type {
  DisplayTextLookups,
  MemoryRecordDisplayResolver,
  MemoryRecordDisplayTextResolver,
} from "./internal/record-display.ts";
export type {
  MemoryRecordMutationBatchInput,
  MemoryRecordMutationOperation,
  MemoryRecordMutationResult,
} from "./internal/record-mutations.ts";
export type {
  MemoryEvidenceRepository,
  MemoryRecordHistoryQuery,
  MemoryRecordMutation,
  MemoryRecordRepository,
} from "./ports/memory-record-repository.ts";
export type { MemoryChangeFingerprint, MemoryChangeSource } from "./ports/change-source.ts";
export { memoryChangesEqual } from "./ports/change-source.ts";
export {
  MEMORY_PROPOSAL_TEMP_ID_PREFIX,
  isProposalTempId,
  memoryProposalBatch,
  memoryProposalError,
} from "./internal/proposal.ts";
export type {
  MemoryMutationBatch,
  MemoryProposalCreateOperation,
  MemoryProposalDeleteOperation,
  MemoryProposalError,
  MemoryProposalOperation,
  MemoryProposalUpdateOperation,
} from "./internal/proposal.ts";
export {
  validateProposalOperation,
  validateProposalOperations,
} from "./internal/proposal-validation.ts";
export type { MemoryProposalPorts } from "./internal/proposal-validation.ts";
export { memoryProposalSubmission, previewProposal } from "./internal/proposal-preview.ts";
export type {
  MemoryMessageRange,
  MemoryProposalPreview,
  MemoryProposalPreviewChange,
  MemoryProposalPreviewOperation,
  MemoryProposalSubmission,
} from "./internal/proposal-preview.ts";
export {
  DomainError,
  effectiveVectorIndexGroups,
  upgradeVectorIndexKeys,
  validateVectorIndexConfiguration,
  remapVectorIndexConfiguration,
  derivedDisplayTemplate,
  memoryFieldConfiguration,
  memoryFieldName,
  memoryFieldPosition,
  memoryFieldKey,
  memoryFieldValuePattern,
  memorySpaceName,
  memoryTableDisplayFieldIds,
  memoryTableName,
  memoryTableKey,
  memoryTablePosition,
  remapMemoryTableDisplayStrategy,
} from "./domain/index.ts";
export type {
  DomainErrorData,
  VectorIndexConfiguration,
  VectorIndexGroup,
  DomainErrorType,
  MemoryEvidence,
  MemoryEvidenceId,
  MemoryEvidenceInput,
  MemoryEvidenceReference,
  MemoryEvidenceSnapshot,
  MemoryEvidenceSourceId,
  MemoryField,
  MemoryFieldEvidence,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryFieldType,
  MemoryFieldValue,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemoryRecordPayload,
  MemoryRecordSource,
  MemoryRevisionId,
  MemoryRevisionSource,
  MemorySpace,
  MemorySpaceId,
  MemorySpaceInitializationSource,
  MemoryTable,
  MemoryTableDisplayStrategy,
  MemoryTableId,
  MemoryTableKey,
} from "./domain/index.ts";

export type {
  MemoryMacro,
  MacroExpression,
  MacroQuery,
  MacroSemanticOptions,
  MacroQueryInput,
  MacroQueryValue,
  MacroSemanticSource,
} from "./domain/memory-macro.ts";

export { compileMemoryQueryConditions } from "./query-sql-conditions.ts";
