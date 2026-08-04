import type {
  MemoryField,
  MemoryFieldKey,
  MemoryFieldType,
  MemoryFieldId,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  MemoryTableKey,
} from "../memory/index.ts";
import type { MemorySpaceReader } from "./memory-space-reader.ts";

/**
 * 单个启用字段的 schema 摘要（模型可见范围 = 工具可用范围）。
 * `referenceTableKey` 是该字段引用目标表的 key（引用字段 v1 返回裸记录 id，
 * 目标表 key 供模型理解值含义）；`id` 仅用于工具内部 key→id 映射，不进提示词。
 */
export interface MemoryFieldDigest {
  readonly id: MemoryFieldId;
  readonly key: MemoryFieldKey;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly options: readonly string[];
  readonly referenceTableKey: MemoryTableKey | null;
}

/** 单个启用表的 schema 摘要；`id` 仅用于工具内部 key→id 映射，不进提示词。 */
export interface MemoryTableDigest {
  readonly id: MemoryTableId;
  readonly key: MemoryTableKey;
  readonly name: string;
  readonly description: string;
  readonly fields: readonly MemoryFieldDigest[];
}

/**
 * 某一记忆空间的启用表/字段摘要：每次 run 启动时构建一次，
 * 提示词组合（prompt-composer）与 query_records 工具校验共用同一份，
 * 保证模型看到的表/字段与工具实际接受的完全一致。
 */
export interface MemorySpaceTableDigest {
  readonly memorySpaceId: MemorySpaceId;
  readonly tables: readonly MemoryTableDigest[];
}

/**
 * 构建摘要：只收录启用表与启用字段；引用目标的 key 从该空间的全部表
 * （含未启用表）解析，保证引用字段的目标 key 总能显示。
 */
export async function buildMemorySpaceTableDigest(
  reader: MemorySpaceReader,
  memorySpaceId: MemorySpaceId,
): Promise<MemorySpaceTableDigest> {
  const tables = await reader.listTables(memorySpaceId);
  const tableKeyById = new Map(tables.map((table) => [table.id, table.key]));

  const digests = await Promise.all(
    tables
      .filter((table) => table.enabled)
      .map(async (table) => digestTable(reader, table, tableKeyById)),
  );
  return { memorySpaceId, tables: digests };
}

async function digestTable(
  reader: MemorySpaceReader,
  table: MemoryTable,
  tableKeyById: ReadonlyMap<MemoryTableId, MemoryTableKey>,
): Promise<MemoryTableDigest> {
  const fields = await reader.listFields(table.memorySpaceId, table.id);
  return {
    id: table.id,
    key: table.key,
    name: table.name,
    description: table.description,
    fields: fields
      .filter((field) => field.enabled)
      .map((field) => digestField(field, tableKeyById)),
  };
}

function digestField(
  field: MemoryField,
  tableKeyById: ReadonlyMap<MemoryTableId, MemoryTableKey>,
): MemoryFieldDigest {
  return {
    id: field.id,
    key: field.key,
    name: field.name,
    type: field.type,
    required: field.required,
    options: field.options,
    referenceTableKey: field.referenceTableId
      ? (tableKeyById.get(field.referenceTableId) ?? null)
      : null,
  };
}

/** 按 key 查找启用表；不存在或未启用返回 undefined。 */
export function findTableInDigest(
  digest: MemorySpaceTableDigest,
  tableKey: string,
): MemoryTableDigest | undefined {
  return digest.tables.find((table) => table.key === tableKey);
}

/** 按 key 查找启用字段；不存在或未启用返回 undefined。 */
export function findFieldInDigest(
  table: MemoryTableDigest,
  fieldKey: string,
): MemoryFieldDigest | undefined {
  return table.fields.find((field) => field.key === fieldKey);
}
