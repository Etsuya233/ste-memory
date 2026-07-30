import type {
  MemoryFieldId,
  MemoryFieldValue,
  MemoryRecord,
  MemoryTableId,
} from "../domain/index.ts";

export type QueryRecordSystemFieldId =
  "$record_id" | "$display_text" | "$created_at" | "$updated_at";
export type QueryRecordFieldId = MemoryFieldId | QueryRecordSystemFieldId;
export type QueryRecordOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal";

export interface QueryRecordsCondition {
  readonly fieldId: QueryRecordFieldId;
  readonly operator: QueryRecordOperator;
  readonly value: MemoryFieldValue;
}

export interface QueryRecordsInput {
  readonly tableId: MemoryTableId;
  readonly fieldIds?: readonly MemoryFieldId[];
  readonly conditions?: readonly QueryRecordsCondition[];
  readonly paging: { readonly page: number; readonly pageSize: number };
  readonly order?: {
    readonly fieldId: QueryRecordFieldId;
    readonly direction: "asc" | "desc";
  };
}

export interface QueryRecordsPage {
  readonly records: readonly MemoryRecord[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export const systemFields = new Set<QueryRecordSystemFieldId>([
  "$record_id",
  "$display_text",
  "$created_at",
  "$updated_at",
]);
export const equalityOperators = new Set<QueryRecordOperator>(["equals", "not_equals"]);
export const orderedOperators = new Set<QueryRecordOperator>([
  ...equalityOperators,
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);
export const textOperators = new Set<QueryRecordOperator>([...equalityOperators, "contains"]);
export const listOperators = new Set<QueryRecordOperator>(["contains", "not_contains"]);
