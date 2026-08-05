import {
  derivedDisplayTemplate,
  DomainError,
  type MemoryField,
  type MemoryRecord,
  type MemoryRecordPayload,
  type MemorySpaceId,
  type MemoryTable,
} from "../domain/index.ts";
import type { MemoryRecordRepository } from "./ports/memory-record-repository.ts";

/**
 * 显示文本计算（领域规则，预览与提交共用同一份）：
 * field 策略取字段值，template 策略渲染模板（引用字段解析为目标记录显示文本）；
 * 未配置显示策略 throw（创建记录前必须配置）。
 */
export async function computeMemoryRecordDisplayText(
  records: MemoryRecordRepository,
  memorySpaceId: MemorySpaceId,
  table: MemoryTable,
  fields: readonly MemoryField[],
  payload: MemoryRecordPayload,
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
  const template = derivedDisplayTemplate(strategy.template);
  let text = template.template;
  for (const fieldId of template.fieldIds) {
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
            values.map((id) =>
              records.find(memorySpaceId, field.referenceTableId!, id as MemoryRecord["id"]),
            ),
          )
        )
          .map((record) => record?.displayText ?? "")
          .join(", ")
      : values.join(", ");
    text = text.replaceAll(`{${fieldId}}`, rendered);
  }
  return text;
}
