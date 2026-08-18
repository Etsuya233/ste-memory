/**
 * 记忆视图翻译层（ADR 0025 / ticket 02 纯函数 seam）：视图 → 记忆查询
 * （core 查询契约，与查询 Agent 工具 / apps HTTP 查询共用同一套读侧语言）。
 *
 * - fieldIds = 投影（无投影省略 = 返回全部启用字段）；
 * - conditions = [{ fieldId: 筛选字段, operator: 'in', value: values }]
 *   （恒用 in：多值 = 值数组，单值 = 单元素数组）；
 * - order = { fieldId: '$updated_at', direction: 'desc' }；
 * - paging = { page: 1, pageSize: limit ?? 100 }（契约 pageSize 上限 100；
 *   无条数上限时取 100，全局字符上限兜底截断使其实际影响不可见）。
 *
 * 表/字段 Key 经 digest（buildMemorySpaceTableDigest：启用表/启用字段）校验并映射
 * 为 id；缺表/缺字段（含字段 Key 被改名、表/字段停用）→ 翻译失败（undefined）→
 * 该视图快照 = 空串 + 日志（面板可显示配置错误）。筛选字段类型限定
 * single_select / short_text（v1 单条件，值集合为字符串）。
 *
 * 引用解析补充查询（resolveViewReferenceLabels）：投影含引用字段时，查询结果
 * payload 里引用为裸记录 id——按引用目标表收集 id 集合，用 $record_id in 批量
 * 查询目标记录显示文本（契约 pageSize ≤ 100，超量分片；先例：
 * ui/record-view.tsx 查看模式的引用解析逻辑）。
 */
import type {
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordId,
  MemorySpaceId,
} from "@ste-memory/core/memory";
import type {
  MemorySpaceReader,
  MemorySpaceTableDigest,
  MemoryTableDigest,
} from "@ste-memory/core/memory/agent";
import { findFieldInDigest, findTableInDigest } from "@ste-memory/core/memory/agent";
import type { QueryRecordsCondition, QueryRecordsInput } from "@ste-memory/core/memory";
import { MEMORY_VIEW_CONDITION_FIELD_TYPES, MEMORY_VIEW_LIMIT_MAX, type MemoryView } from "../settings/memory-views.ts";

/** 翻译结果：查询输入 + 视图表 digest（渲染层字段名/引用目标 key 的元数据源） */
export interface MemoryViewQueryPlan {
  readonly query: QueryRecordsInput;
  readonly table: MemoryTableDigest;
}

/**
 * 视图 → 记忆查询。缺表/缺字段/筛选字段类型不支持 → undefined（配置错误）。
 */
export function planMemoryViewQuery(
  view: MemoryView,
  digest: MemorySpaceTableDigest,
): MemoryViewQueryPlan | undefined {
  const table = findTableInDigest(digest, view.tableKey);
  if (!table) return undefined;
  const fieldIds: MemoryFieldId[] = [];
  for (const key of view.projection) {
    const field = findFieldInDigest(table, key);
    if (!field) return undefined;
    fieldIds.push(field.id);
  }
  let conditions: readonly QueryRecordsCondition[] | undefined;
  if (view.condition) {
    const field = findFieldInDigest(table, view.condition.fieldKey);
    if (!field || !MEMORY_VIEW_CONDITION_FIELD_TYPES.has(field.type)) return undefined;
    conditions = [{ fieldId: field.id, operator: "in", value: [...view.condition.values] }];
  }
  return {
    table,
    query: {
      tableId: table.id,
      ...(fieldIds.length > 0 ? { fieldIds } : {}),
      ...(conditions !== undefined ? { conditions } : {}),
      order: { fieldId: "$updated_at", direction: "desc" },
      paging: { page: 1, pageSize: view.limit ?? MEMORY_VIEW_LIMIT_MAX },
    },
  };
}

/**
 * 引用解析补充查询：投影含引用字段时，把查询结果里的裸记录 id 解析为目标记录
 * 显示文本（跨目标表收集；目标表缺失/停用 → 跳过，渲染层兜底显示原 id）。
 */
export async function resolveViewReferenceLabels(
  reader: MemorySpaceReader,
  spaceId: MemorySpaceId,
  digest: MemorySpaceTableDigest,
  table: MemoryTableDigest,
  records: readonly MemoryRecord[],
  projectionKeys: readonly string[],
): Promise<ReadonlyMap<MemoryRecordId, string>> {
  const labels = new Map<MemoryRecordId, string>();
  for (const key of projectionKeys) {
    const field = findFieldInDigest(table, key);
    if (!field) continue;
    if (field.type !== "single_reference" && field.type !== "multi_reference") continue;
    const targetTable = field.referenceTableKey
      ? digest.tables.find((candidate) => candidate.key === field.referenceTableKey)
      : undefined;
    if (!targetTable) continue;
    const ids = collectReferenceIds(records, field.id);
    if (ids.length === 0) continue;
    // $record_id in 批量查询（契约 pageSize ≤ 100；超量分片）
    for (let offset = 0; offset < ids.length; offset += MEMORY_VIEW_LIMIT_MAX) {
      const chunk = ids.slice(offset, offset + MEMORY_VIEW_LIMIT_MAX);
      const page = await reader.queryRecords(spaceId, {
        tableId: targetTable.id,
        conditions: [{ fieldId: "$record_id", operator: "in", value: chunk }],
        paging: { page: 1, pageSize: chunk.length },
      });
      for (const record of page.records) labels.set(record.id, record.displayText);
    }
  }
  return labels;
}

/** 收集投影字段值里的记录 id（单引用 = 标量；多引用 = 数组；去重保序）。 */
function collectReferenceIds(
  records: readonly MemoryRecord[],
  fieldId: MemoryFieldId,
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const value = record.payload[fieldId];
    const candidates = Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
    for (const candidate of candidates) {
      if (typeof candidate !== "string" || seen.has(candidate)) continue;
      seen.add(candidate);
      ids.push(candidate);
    }
  }
  return ids;
}
