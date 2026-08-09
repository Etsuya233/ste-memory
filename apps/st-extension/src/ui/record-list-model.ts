/**
 * 记录列表（ticket 11）的纯逻辑 seam：来源徽标文案 / 行视图模型 /
 * 修订摘要。组件只做「模型 → DOM」投影与事件接线，本模块独立测试。
 *
 * 来源语义（core MemoryRecordSource）：manual = 手动创建；source = 有证据来源
 * （Agent 修订产物）。修订来源（MemoryRevisionSource）：user / agent。
 */
import type {
  MemoryRecord,
  MemoryRecordSource,
  MemoryRevisionSource,
} from "@ste-memory/core/memory";

/** 记录来源徽标文案（详情与列表共用） */
export function recordSourceLabel(source: MemoryRecordSource): string {
  return source.type === "manual" ? "手动" : "Agent";
}

/** 修订来源徽标文案 */
export function revisionSourceLabel(source: MemoryRevisionSource): string {
  return source === "user" ? "手动修订" : "Agent 修订";
}

export interface RecordRowViewModel {
  readonly id: MemoryRecord["id"];
  /** 列表行主文案：读时计算的显示文本（core 规则），计算失败降级存储 displayText */
  readonly displayText: string;
  readonly sourceLabel: string;
  readonly updatedAt: string;
}

export function buildRecordRowViewModels(
  records: readonly MemoryRecord[],
  displayTextByRecord: ReadonlyMap<MemoryRecord["id"], string>,
): RecordRowViewModel[] {
  return records.map((record) => ({
    id: record.id,
    displayText: displayTextByRecord.get(record.id) ?? record.displayText,
    sourceLabel: recordSourceLabel(record.source),
    updatedAt: record.updatedAt,
  }));
}

/** 详情修订摘要：最新一条历史（archivedAt 倒序，repo 已排）的来源 + 修订总数；无历史返回 null */
export function revisionSummaryLine(
  history: readonly {
    readonly revisionSource: MemoryRevisionSource;
    readonly archivedAt: string;
  }[],
): string | null {
  if (history.length === 0) return null;
  const latest = history[0]!;
  return `${revisionSourceLabel(latest.revisionSource)} · ${latest.archivedAt.slice(0, 16).replace("T", " ")} · 共 ${history.length} 次修订`;
}
