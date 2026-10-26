export { DomainError } from "./domain-error.ts";
export {
  effectiveVectorIndexGroups,
  upgradeVectorIndexKeys,
  validateVectorIndexConfiguration,
  remapVectorIndexConfiguration,
} from "./vector-index-configuration.ts";
export type { VectorIndexConfiguration, VectorIndexGroup } from "./vector-index-configuration.ts";
export type { DomainErrorData, DomainErrorType } from "./domain-error.ts";
export {
  memoryFieldConfiguration,
  memoryFieldKey,
  memoryFieldName,
  memoryFieldPosition,
  memoryFieldValuePattern,
} from "./memory-field.ts";
export type {
  MemoryField,
  MemoryFieldConfiguration,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryFieldType,
} from "./memory-field.ts";
export {
  derivedDisplayTemplate,
  memoryTableDisplayFieldIds,
  memoryTableKey,
  memoryTableName,
  memoryTablePosition,
  remapMemoryTableDisplayStrategy,
} from "./memory-table.ts";
export type {
  DerivedDisplayTemplate,
  MemoryTable,
  MemoryTableDisplayStrategy,
  MemoryTableId,
  MemoryTableKey,
} from "./memory-table.ts";
export { memorySpaceName } from "./memory-space.ts";
export type {
  MemorySpace,
  MemorySpaceId,
  MemorySpaceInitializationSource,
} from "./memory-space.ts";
export type {
  MemoryEvidence,
  MemoryEvidenceId,
  MemoryEvidenceInput,
  MemoryEvidenceReference,
  MemoryEvidenceSnapshot,
  MemoryEvidenceSourceId,
  MemoryFieldEvidence,
  MemoryFieldValue,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemoryRecordPayload,
  MemoryRecordSource,
  MemoryRevisionId,
  MemoryRevisionSource,
} from "./memory-record.ts";

export type {
  MemoryMacro,
  MacroExpression,
  MacroQuery,
  MacroQueryInput,
  MacroQueryValue,
  MacroSemanticSource,
} from "./memory-macro.ts";
