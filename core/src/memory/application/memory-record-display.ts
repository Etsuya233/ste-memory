import {
  derivedDisplayTemplate,
  DomainError,
  type MemoryField,
  type MemoryFieldId,
  type MemoryRecord,
  type MemoryRecordPayload,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
} from "../domain/index.ts";
import type { MemoryRecordRepository } from "./ports/memory-record-repository.ts";

/**
 * 引用解析器：给定目标表与记录标识，返回目标记录的显示文本（未找到 → ""）。
 * 记录标识可能是批内临时 ID（tmp: 前缀，预览/提交阶段尚未落库的 create 引用），
 * 批内解析由 createBatchReferenceResolver 提供，仓库兜底。
 */
export type MemoryRecordDisplayTextResolver = (
  tableId: MemoryTableId,
  recordId: string,
) => Promise<string>;

/**
 * 显示文本计算（领域规则，预览与提交共用同一份）：
 * field 策略取字段值，template 策略渲染模板（引用字段解析为目标记录显示文本）；
 * 未配置显示策略 throw（创建记录前必须配置）。
 *
 * resolveReference 可选：缺省只查仓库（引用已落库记录）；批内待落库记录
 * （同一提交批次/提案里新建、尚未 commit 的记录）由调用方注入批内感知的解析器。
 */
export async function computeMemoryRecordDisplayText(
  records: MemoryRecordRepository,
  memorySpaceId: MemorySpaceId,
  table: MemoryTable,
  fields: readonly MemoryField[],
  payload: MemoryRecordPayload,
  resolveReference?: MemoryRecordDisplayTextResolver,
): Promise<string> {
  const strategy = table.displayStrategy;
  if (!strategy) {
    throw new DomainError({
      type: "memory_record_display_strategy_missing",
      humanMsg: "创建记录前必须配置表格显示策略",
    });
  }
  if (strategy.type === "field") {
    return String(payload[strategy.fieldId] ?? "");
  }
  const resolve =
    resolveReference ??
    (async (tableId, recordId) =>
      (await records.find(memorySpaceId, tableId, recordId as MemoryRecord["id"]))?.displayText ??
      "");
  return renderMemoryRecordDisplayTemplate(strategy.template, fields, payload, resolve);
}

/** 模板渲染所需的字段视图：仅 id 与引用目标表 id（提交路径传 MemoryField，查询工具传摘要字段）。 */
export interface MemoryDisplayTemplateField {
  readonly id: MemoryFieldId;
  readonly referenceTableId: MemoryTableId | null;
}

/**
 * 模板策略渲染（领域规则与 computeMemoryRecordDisplayText 共用）：按模板占位符
 * 逐字段替换，引用字段经 resolveReference 解析为目标记录显示文本。
 * 调用方自行保证模板字段在当前表字段集合中存在（表策略设置时已校验）。
 */
export async function renderMemoryRecordDisplayTemplate(
  template: string,
  fields: readonly MemoryDisplayTemplateField[],
  payload: MemoryRecordPayload,
  resolveReference: MemoryRecordDisplayTextResolver,
): Promise<string> {
  const derived = derivedDisplayTemplate(template);
  let text = derived.template;
  for (const fieldId of derived.fieldIds) {
    const field = fields.find((item) => item.id === fieldId)!;
    const value = payload[fieldId];
    const values = Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
    const rendered = field.referenceTableId
      ? (
          await Promise.all(
            values.map((id) => resolveReference(field.referenceTableId!, String(id))),
          )
        ).join(", ")
      : values.join(", ");
    text = text.replaceAll(`{${fieldId}}`, rendered);
  }
  return text;
}

/** 批内待落库记录（显示文本引用解析用）：提交路径 id 为真实记录 id，预览路径为临时 id。 */
export interface PendingDisplayRecord {
  readonly id: string;
  readonly table: MemoryTable;
  readonly fields: readonly MemoryField[];
  readonly payload: MemoryRecordPayload;
}

/**
 * 构造「批次感知」引用解析器：先按 id + 目标表匹配批内待落库记录，未命中回退仓库。
 * 批内记录的显示文本按需惰性计算——引用链可递归（如关系→人物→地点），
 * 结果缓存（同批被多处引用只算一次），引用环保护（环内按未找到渲染空，不无限递归）。
 */
export function createBatchReferenceResolver(options: {
  readonly pending: readonly PendingDisplayRecord[];
  readonly fallback: MemoryRecordDisplayTextResolver;
  readonly compute: (
    record: PendingDisplayRecord,
    resolve: MemoryRecordDisplayTextResolver,
  ) => Promise<string>;
}): MemoryRecordDisplayTextResolver {
  const byId = new Map(options.pending.map((record) => [record.id, record]));
  const cache = new Map<string, string>();
  const computing = new Set<string>();
  const resolve: MemoryRecordDisplayTextResolver = async (tableId, recordId) => {
    const cached = cache.get(recordId);
    if (cached !== undefined) return cached;
    const pending = byId.get(recordId);
    if (!pending || pending.table.id !== tableId) return options.fallback(tableId, recordId);
    if (computing.has(recordId)) return ""; // 引用环：该链路显示文本无解，按未找到渲染
    computing.add(recordId);
    try {
      const text = await options.compute(pending, resolve);
      cache.set(recordId, text);
      return text;
    } catch (error) {
      cache.set(recordId, "");
      throw error;
    } finally {
      computing.delete(recordId);
    }
  };
  return resolve;
}
