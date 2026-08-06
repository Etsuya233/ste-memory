import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  DomainError,
  type MemoryFieldId,
  type MemoryFieldValue,
  type MemoryRecordId,
  type MemoryRevisionId,
} from "../../../../domain/index.ts";
import type {
  QueryRecordFieldId,
  QueryRecordsCondition,
  QueryRecordsPage,
} from "../../../memory-record-query-contract.ts";
import {
  findFieldInDigest,
  findTableInDigest,
  availableFieldKeys,
  availableTableKeys,
  type MemorySpaceTableDigest,
} from "../../digest.ts";
import type { MemorySpaceReader } from "../../memory-space-reader.ts";

export const QUERY_RECORDS_TOOL_NAME = "query_records";

// ---------------------------------------------------------------------------
// 参数 Schema（TypeBox）：形状错误由 pi 在 execute 前拦截（validateToolArguments）
// ---------------------------------------------------------------------------

const queryRecordOperatorSchema = Type.Enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
]);

const queryRecordConditionSchema = Type.Object({
  field: Type.String(),
  op: queryRecordOperatorSchema,
  value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
});

const queryRecordsParamsSchema = Type.Object({
  table: Type.String(),
  fields: Type.Optional(Type.Array(Type.String())),
  conditions: Type.Optional(Type.Array(queryRecordConditionSchema)),
  paging: Type.Optional(
    Type.Object({
      page: Type.Integer(),
      pageSize: Type.Integer(),
    }),
  ),
  orderBy: Type.Optional(
    Type.Object({
      field: Type.String(),
      direction: Type.Enum(["asc", "desc"]),
    }),
  ),
});

export type QueryRecordsToolParams = Static<typeof queryRecordsParamsSchema>;

// ---------------------------------------------------------------------------
// 结果形状：剥掉 fieldEvidence/source/tableId/memorySpaceId 等噪音，
// values 用字段 key 键控；引用字段 v1 裸 id；revisionId 为乐观并发版本号
// ---------------------------------------------------------------------------

export interface QueryRecordsToolResultRecord {
  readonly id: MemoryRecordId;
  readonly revisionId: MemoryRevisionId;
  readonly display: string;
  readonly values: Readonly<Record<string, MemoryFieldValue>>;
}

export interface QueryRecordsToolResult {
  readonly table: string;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly records: readonly QueryRecordsToolResultRecord[];
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

export interface QueryRecordsToolDependencies {
  readonly reader: MemorySpaceReader;
  /** run 启动时构建一次的启用表/字段摘要，提示词与工具校验共用。 */
  readonly digest: MemorySpaceTableDigest;
}

export function createQueryRecordsTool(
  deps: QueryRecordsToolDependencies,
): AgentTool<typeof queryRecordsParamsSchema, QueryRecordsToolResult> {
  return {
    name: QUERY_RECORDS_TOOL_NAME,
    label: "查询记忆记录",
    description: QUERY_RECORDS_TOOL_DESCRIPTION,
    parameters: queryRecordsParamsSchema,
    async execute(_toolCallId, params) {
      const result = await executeQueryRecords(deps, params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

const QUERY_RECORDS_TOOL_DESCRIPTION = [
  "查询记忆空间中的记录（只读，可并发多次调用）。参数全部使用表/字段 key：",
  "- table：表 key，必填。可用表 key 见系统提示中的摘要；填错会报错并附带可用 key 列表。",
  "- fields：返回的字段 key 列表；省略时返回该表全部启用字段。",
  "- conditions：过滤条件列表，多个条件为 AND 语义（OR 请分多次查询）。",
  "  每项为 { field, op, value }：field 是字段 key 或系统字段（$record_id 仅支持 equals/not_equals，",
  "  $display_text 支持文本操作符，$created_at/$updated_at 支持有序操作符）；",
  "  op 取值 equals / not_equals / contains / not_contains / greater_than /",
  "  greater_than_or_equal / less_than / less_than_or_equal，其中 contains 对文本是大小写不敏感",
  "  的子串匹配、对列表字段（多选/多引用/短文本列表）是成员匹配，not_contains 仅限列表字段；",
  "  value 为 string / number / boolean / null，操作符与字段类型不匹配会被拒绝。",
  "- paging：可选，默认 { page: 1, pageSize: 20 }，pageSize 上限 100。",
  "- orderBy：可选，{ field, direction: asc|desc }，field 为字段 key 或系统字段；多值字段不可排序。",
  "结果 records 中的 values 以字段 key 键控，引用字段的值为目标记录 id，revisionId 是记录版本号；",
  "查不到记录时 records 为空数组，请如实回答。",
].join("\n");

// ---------------------------------------------------------------------------
// 执行流：digest 校验（表/字段存在且启用）→ key→id 映射 → 查询端口
// → 服务层类型感知校验（op×类型、选项、排序可排序性）→ id→key 反映射
// ---------------------------------------------------------------------------

async function executeQueryRecords(
  deps: QueryRecordsToolDependencies,
  params: QueryRecordsToolParams,
): Promise<QueryRecordsToolResult> {
  const table = findTableInDigest(deps.digest, params.table);
  if (!table) {
    throw new QueryRecordsToolError(
      `表 key「${params.table}」不存在或未启用。可用表 key：${availableTableKeys(deps.digest)}。`,
    );
  }

  const fieldIds = (params.fields ?? table.fields.map((field) => field.key)).map((key) =>
    resolveProjectionFieldKey(table, key),
  );
  const conditions: readonly QueryRecordsCondition[] = (params.conditions ?? []).map(
    (condition) => ({
      fieldId: resolveQueryFieldKey(table, condition.field, "条件字段"),
      operator: condition.op,
      value: condition.value,
    }),
  );
  const order = params.orderBy
    ? {
        fieldId: resolveQueryFieldKey(table, params.orderBy.field, "排序字段"),
        direction: params.orderBy.direction,
      }
    : undefined;

  const fieldKeyById = new Map(table.fields.map((field) => [field.id, field.key]));
  let page: QueryRecordsPage;
  try {
    page = await deps.reader.queryRecords(deps.digest.memorySpaceId, {
      tableId: table.id,
      fieldIds,
      conditions,
      paging: params.paging ?? DEFAULT_PAGING,
      order,
    });
  } catch (error) {
    throw translateQueryError(error, fieldKeyById);
  }

  return {
    table: table.key,
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
    totalPages: page.totalPages,
    records: page.records.map((record) => ({
      id: record.id,
      revisionId: record.revisionId,
      display: record.displayText,
      values: Object.fromEntries(payloadEntriesKeyedByFieldKey(record, fieldKeyById)),
    })),
  };
}

const DEFAULT_PAGING = { page: 1, pageSize: 20 } as const;

/** 投影字段：只接受用户字段 key（系统字段只能用于 conditions/orderBy）。 */
function resolveProjectionFieldKey(
  table: MemorySpaceTableDigest["tables"][number],
  key: string,
): MemoryFieldId {
  if (key.startsWith("$")) {
    throw new QueryRecordsToolError(
      `系统字段「${key}」不能用于投影 fields，只能用于 conditions/orderBy。`,
    );
  }
  return resolveUserFieldKey(table, key, "投影字段");
}

/** 条件/排序字段：用户字段 key 经 digest 校验并映射为字段 id；系统字段（$ 前缀）原样透传。 */
function resolveQueryFieldKey(
  table: MemorySpaceTableDigest["tables"][number],
  key: string,
  usage: string,
): QueryRecordFieldId {
  if (key.startsWith("$")) return key as QueryRecordFieldId;
  return resolveUserFieldKey(table, key, usage);
}

function resolveUserFieldKey(
  table: MemorySpaceTableDigest["tables"][number],
  key: string,
  usage: string,
): MemoryFieldId {
  const field = findFieldInDigest(table, key);
  if (!field) {
    throw new QueryRecordsToolError(
      `字段 key「${key}」在表「${table.key}」中不存在或未启用（${usage}）。可用字段 key：${availableFieldKeys(table)}。`,
    );
  }
  return field.id;
}

/** payload 以字段 id 键控，映射回字段 key；不在摘要中的 id 丢弃（摘要即模型可见契约）。 */
function payloadEntriesKeyedByFieldKey(
  record: QueryRecordsPage["records"][number],
  fieldKeyById: ReadonlyMap<string, string>,
): readonly (readonly [string, MemoryFieldValue])[] {
  return Object.entries(record.payload).flatMap(([fieldId, value]) => {
    const key = fieldKeyById.get(fieldId);
    return key === undefined ? [] : [[key, value] as const];
  });
}

// ---------------------------------------------------------------------------
// 错误处理：服务层 DomainError 转可读信息回喂，模型可据此自愈
// ---------------------------------------------------------------------------

export class QueryRecordsToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryRecordsToolError";
  }
}

const QUERY_REJECTION_REASON_TEXT: Readonly<Record<string, string>> = {
  shape_invalid: "参数形状无效",
  table_not_found: "表不存在",
  paging_invalid: "分页无效（page 从 1 起，pageSize 为 1–100）",
  projection_field_not_found: "投影字段不存在",
  condition_field_not_found: "条件字段不存在",
  condition_invalid: "操作符或值与字段类型不匹配",
  order_field_not_found: "排序字段不存在",
  order_field_not_sortable: "多值字段不可排序",
  order_invalid: "排序方向无效",
};

function translateQueryError(error: unknown, fieldKeyById: ReadonlyMap<string, string>): never {
  if (error instanceof DomainError && error.type === "memory_record_query_invalid") {
    const param = error.param as
      { readonly reason?: string; readonly fieldId?: string } | undefined;
    const reason = param?.reason;
    const reasonText = reason ? (QUERY_REJECTION_REASON_TEXT[reason] ?? reason) : "参数被拒绝";
    const fieldId = param?.fieldId;
    const fieldText = fieldId ? `，字段：${fieldKeyById.get(fieldId) ?? fieldId}` : "";
    throw new QueryRecordsToolError(`查询被拒绝：${reasonText}${fieldText}。请修正参数后重试。`);
  }
  throw error;
}
