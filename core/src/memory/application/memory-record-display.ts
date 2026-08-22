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

/** 读时显示文本解析器：给定一条已落库记录，返回按当前定义与目标记录重渲的显示文本。 */
export type MemoryRecordDisplayResolver = (record: MemoryRecord) => Promise<string>;

/** 读时显示文本的记录查找视图：宿主各自提供（仓库逐条查 / 预载映射等），作用域由实现闭合。 */
export interface DisplayTextLookups {
  readonly getTable: (tableId: MemoryTableId) => Promise<MemoryTable | undefined>;
  readonly getFields: (tableId: MemoryTableId) => Promise<readonly MemoryField[]>;
  readonly findRecord: (
    tableId: MemoryTableId,
    recordId: string,
  ) => Promise<MemoryRecord | undefined>;
}

/**
 * 读时显示文本解析器（查询路径共用，存储 displayText 降级为兜底缓存）：
 * - field 策略 / 无策略：直接返回存储值（= 字段值派生，无过期风险，零额外查询）；
 * - template 策略：按当前表/字段定义与目标记录当前状态重渲——引用目标递归解析
 *   （结果缓存、祖先链判环、目标缺失渲染空串），单个引用失败渲染空串不毒化整体；
 * - 顶层渲染异常（模板引用已删字段等定义漂移）：回退存储 displayText。
 *
 * 判环用调用链祖先集合而非全局在途标记：并发解析同一目标（如两条关系记录引
 * 同一个人物）不算环、各自完整计算；只有递归回到自身链路才按未找到渲染。
 * 实例持有缓存，一次查询调用内构建一次、用完即弃；表/字段定义同样按 tableId 缓存。
 */
export function createReadTimeDisplayTextResolver(
  lookups: DisplayTextLookups,
): MemoryRecordDisplayResolver {
  const tables = new Map<MemoryTableId, MemoryTable | undefined>();
  const fieldsByTable = new Map<MemoryTableId, readonly MemoryField[]>();
  const displayByText = new Map<string, string>();

  const loadTable = async (tableId: MemoryTableId): Promise<MemoryTable | undefined> => {
    if (!tables.has(tableId)) tables.set(tableId, await lookups.getTable(tableId));
    return tables.get(tableId);
  };

  const loadFields = async (tableId: MemoryTableId): Promise<readonly MemoryField[]> => {
    const cached = fieldsByTable.get(tableId);
    if (cached) return cached;
    const loaded = await lookups.getFields(tableId);
    fieldsByTable.set(tableId, loaded);
    return loaded;
  };

  /** 按记录自身策略渲染（field 取存储值 / template 重渲）；定义漂移等异常向上抛。 */
  const renderRecord = async (
    record: MemoryRecord,
    ancestry: ReadonlySet<string>,
  ): Promise<string> => {
    const table = await loadTable(record.tableId);
    const strategy = table?.displayStrategy;
    if (!strategy || strategy.type !== "template") return record.displayText;
    return renderMemoryRecordDisplayTemplate(
      strategy.template,
      await loadFields(record.tableId),
      record.payload,
      (tableId, recordId) => resolveReference(tableId, recordId, ancestry),
    );
  };

  /** 引用位置的解析：缺失/失败/环一律空串；环属路径相关结果，只短路不缓存。 */
  const resolveReference = async (
    tableId: MemoryTableId,
    recordId: string,
    ancestry: ReadonlySet<string>,
  ): Promise<string> => {
    const key = `${tableId}:${recordId}`;
    const cached = displayByText.get(key);
    if (cached !== undefined) return cached;
    if (ancestry.has(key)) return ""; // 引用环：该链路无解，按未找到渲染
    const record = await lookups.findRecord(tableId, recordId);
    if (!record) {
      displayByText.set(key, ""); // 未找到与解析路径无关，可安全缓存
      return "";
    }
    try {
      const text = await renderRecord(record, new Set([...ancestry, key]));
      displayByText.set(key, text);
      return text;
    } catch {
      displayByText.set(key, "");
      return "";
    }
  };

  return async (record) => {
    const key = `${record.tableId}:${record.id}`;
    const cached = displayByText.get(key);
    if (cached !== undefined) return cached;
    try {
      const text = await renderRecord(record, new Set([key]));
      displayByText.set(key, text);
      return text;
    } catch {
      return record.displayText; // 渲染异常：回退存储值（显示是辅助信息，不阻断查询）
    }
  };
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
