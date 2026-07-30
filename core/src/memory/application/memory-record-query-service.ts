import {
  DomainError,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldValue,
  type MemoryRecord,
  type MemorySpaceId,
} from "../domain/index.ts";
import type { MemoryFieldRepository } from "./ports/memory-field-repository.ts";
import type { MemoryRecordRepository } from "./ports/memory-record-repository.ts";
import type { MemoryTableRepository } from "./ports/memory-table-repository.ts";
import { validateMemoryFieldValue } from "./memory-record-validation.ts";
import {
  equalityOperators,
  listOperators,
  orderedOperators,
  systemFields,
  textOperators,
  type QueryRecordFieldId,
  type QueryRecordOperator,
  type QueryRecordSystemFieldId,
  type QueryRecordsCondition,
  type QueryRecordsInput,
  type QueryRecordsPage,
} from "./memory-record-query-contract.ts";

export type {
  QueryRecordFieldId,
  QueryRecordOperator,
  QueryRecordSystemFieldId,
  QueryRecordsCondition,
  QueryRecordsInput,
  QueryRecordsPage,
} from "./memory-record-query-contract.ts";

export class MemoryRecordQueryService {
  readonly #tables: MemoryTableRepository;
  readonly #fields: MemoryFieldRepository;
  readonly #records: MemoryRecordRepository;

  constructor(
    tables: MemoryTableRepository,
    fields: MemoryFieldRepository,
    records: MemoryRecordRepository,
  ) {
    this.#tables = tables;
    this.#fields = fields;
    this.#records = records;
  }

  async query(memorySpaceId: MemorySpaceId, input: QueryRecordsInput): Promise<QueryRecordsPage> {
    this.#validateShape(input);
    const table = await this.#tables.find(memorySpaceId, input.tableId);
    if (!table) this.#invalid(input, "table_not_found");
    this.#validatePaging(input);

    const fields = await this.#fields.list(memorySpaceId, input.tableId);
    const fieldsById = new Map(fields.map((field) => [field.id as string, field]));
    for (const fieldId of input.fieldIds ?? []) {
      if (!fieldsById.has(fieldId)) this.#invalid(input, "projection_field_not_found", fieldId);
    }
    for (const condition of input.conditions ?? []) {
      this.#validateCondition(input, condition, fieldsById);
    }
    this.#validateOrder(input, fieldsById);

    const matches = (await this.#records.list(memorySpaceId, input.tableId)).filter((record) =>
      (input.conditions ?? []).every((condition) => this.#matches(record, condition)),
    );
    matches.sort((left, right) => this.#compareRecords(left, right, input));

    const offset = (input.paging.page - 1) * input.paging.pageSize;
    const pageRecords = matches.slice(offset, offset + input.paging.pageSize);
    return {
      records: pageRecords.map((record) => this.#project(record, input.fieldIds)),
      page: input.paging.page,
      pageSize: input.paging.pageSize,
      total: matches.length,
      totalPages: Math.ceil(matches.length / input.paging.pageSize),
    };
  }

  #validateShape(input: QueryRecordsInput): void {
    const candidate = input as Partial<QueryRecordsInput>;
    if (
      !candidate ||
      typeof candidate.tableId !== "string" ||
      (candidate.fieldIds !== undefined &&
        (!Array.isArray(candidate.fieldIds) ||
          candidate.fieldIds.some((fieldId) => typeof fieldId !== "string"))) ||
      !candidate.paging ||
      typeof candidate.paging !== "object" ||
      (candidate.conditions !== undefined && !Array.isArray(candidate.conditions)) ||
      (candidate.conditions !== undefined &&
        candidate.conditions.some(
          (condition) => typeof condition !== "object" || condition === null,
        )) ||
      (candidate.order !== undefined &&
        (typeof candidate.order !== "object" || candidate.order === null))
    ) {
      this.#invalid(input, "shape_invalid");
    }
  }

  #validatePaging(input: QueryRecordsInput): void {
    const { page, pageSize } = input.paging;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      this.#invalid(input, "paging_invalid");
    }
  }

  #validateCondition(
    input: QueryRecordsInput,
    condition: QueryRecordsCondition,
    fieldsById: ReadonlyMap<string, MemoryField>,
  ): void {
    if (systemFields.has(condition.fieldId as QueryRecordSystemFieldId)) {
      const operators =
        condition.fieldId === "$display_text"
          ? textOperators
          : condition.fieldId === "$record_id"
            ? equalityOperators
            : orderedOperators;
      if (
        !operators.has(condition.operator) ||
        (condition.value !== null && typeof condition.value !== "string")
      ) {
        this.#invalid(input, "condition_invalid", condition.fieldId);
      }
      return;
    }
    const field = fieldsById.get(condition.fieldId);
    if (!field) this.#invalid(input, "condition_field_not_found", condition.fieldId);
    const operators = this.#operatorsFor(field.type);
    if (!operators.has(condition.operator) || !this.#conditionValueMatches(field, condition)) {
      this.#invalid(input, "condition_invalid", condition.fieldId);
    }
  }

  #validateOrder(input: QueryRecordsInput, fieldsById: ReadonlyMap<string, MemoryField>): void {
    const order = input.order;
    if (!order) return;
    if (order.direction !== "asc" && order.direction !== "desc") {
      this.#invalid(input, "order_invalid", order.fieldId);
    }
    if (systemFields.has(order.fieldId as QueryRecordSystemFieldId)) return;
    const field = fieldsById.get(order.fieldId);
    if (!field) this.#invalid(input, "order_field_not_found", order.fieldId);
    if (
      field.type === "short_text_list" ||
      field.type === "multi_select" ||
      field.type === "multi_reference"
    ) {
      this.#invalid(input, "order_field_not_sortable", order.fieldId);
    }
  }

  #operatorsFor(type: MemoryField["type"]): ReadonlySet<QueryRecordOperator> {
    switch (type) {
      case "short_text":
      case "long_text":
        return textOperators;
      case "short_text_list":
      case "multi_select":
      case "multi_reference":
        return listOperators;
      case "integer":
      case "decimal":
      case "date":
      case "datetime":
        return orderedOperators;
      case "boolean":
      case "single_select":
      case "single_reference":
        return equalityOperators;
    }
  }

  #conditionValueMatches(field: MemoryField, condition: QueryRecordsCondition): boolean {
    if (condition.value === null) return equalityOperators.has(condition.operator);
    if (
      field.type === "short_text_list" ||
      field.type === "multi_select" ||
      field.type === "multi_reference"
    ) {
      if (typeof condition.value !== "string" || condition.value.length === 0) return false;
      return field.type !== "multi_select" || field.options.includes(condition.value);
    }
    switch (field.type) {
      case "integer":
        return typeof condition.value === "number" && Number.isInteger(condition.value);
      case "decimal":
        return typeof condition.value === "number" && Number.isFinite(condition.value);
      case "boolean":
        return typeof condition.value === "boolean";
      default:
        try {
          validateMemoryFieldValue({ ...field, required: false }, condition.value);
          return true;
        } catch {
          return false;
        }
    }
  }

  #matches(record: MemoryRecord, condition: QueryRecordsCondition): boolean {
    const actual = this.#value(record, condition.fieldId);
    switch (condition.operator) {
      case "equals":
        return actual === condition.value;
      case "not_equals":
        return actual !== condition.value;
      case "contains":
        return Array.isArray(actual)
          ? actual.includes(condition.value as string)
          : typeof actual === "string" &&
              actual.toLocaleLowerCase().includes(String(condition.value).toLocaleLowerCase());
      case "not_contains":
        return Array.isArray(actual) && !actual.includes(condition.value as string);
      case "greater_than":
        return actual !== null && actual !== undefined && actual > condition.value!;
      case "greater_than_or_equal":
        return actual !== null && actual !== undefined && actual >= condition.value!;
      case "less_than":
        return actual !== null && actual !== undefined && actual < condition.value!;
      case "less_than_or_equal":
        return actual !== null && actual !== undefined && actual <= condition.value!;
    }
  }

  #compareRecords(left: MemoryRecord, right: MemoryRecord, input: QueryRecordsInput): number {
    const order = input.order ?? { fieldId: "$created_at" as const, direction: "asc" as const };
    const leftValue = this.#value(left, order.fieldId);
    const rightValue = this.#value(right, order.fieldId);
    let compared =
      leftValue === rightValue
        ? 0
        : leftValue === null || leftValue === undefined
          ? -1
          : rightValue === null || rightValue === undefined
            ? 1
            : leftValue < rightValue
              ? -1
              : 1;
    if (order.direction === "desc") compared *= -1;
    return compared || left.id.localeCompare(right.id);
  }

  #value(record: MemoryRecord, fieldId: QueryRecordFieldId): MemoryFieldValue | undefined {
    switch (fieldId) {
      case "$record_id":
        return record.id;
      case "$display_text":
        return record.displayText;
      case "$created_at":
        return record.createdAt;
      case "$updated_at":
        return record.updatedAt;
      default:
        return record.payload[fieldId];
    }
  }

  #project(record: MemoryRecord, fieldIds: readonly MemoryFieldId[] | undefined): MemoryRecord {
    if (fieldIds === undefined) return record;
    const entries = fieldIds.flatMap((fieldId) => {
      const value = record.payload[fieldId];
      return value === undefined ? [] : [[fieldId, value] as const];
    });
    return { ...record, payload: Object.fromEntries(entries) };
  }

  #invalid(input: QueryRecordsInput, reason: string, fieldId?: string): never {
    throw new DomainError({
      type: "memory_record_query_invalid",
      param: {
        tableId: input.tableId,
        fieldId,
        fieldIds: input.fieldIds,
        conditions: input.conditions,
        paging: input.paging,
        order: input.order,
        reason,
      },
      humanMsg: "记录查询参数无效",
    });
  }
}
