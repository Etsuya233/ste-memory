import type { MemoryField, MemoryTable } from "../memory/index.ts";
import type { MemorySpaceId } from "../memory/index.ts";
import { capturePresetVectorIndex } from "./preset-vector-index.ts";
import type {
  TablePresetDisplayStrategy,
  TablePresetStructure,
  TablePresetTable,
} from "./preset-model.ts";

/**
 * 当前空间结构 → 预设结构（spec 5.1 / 10.1）：把空间内的表/字段原样复制成预设
 * 内容，把实体 ID 引用改写成 Key 引用——
 *
 * - 引用字段的目标表 ID → 目标表 Key；
 * - 显示策略的字段 ID → 字段 Key（field 与 template 两种形态）；
 * - 停用的表与字段一并保存（应用后保留启用状态）；
 * - 不保存记录、证据、历史、填表任务、同步进度、问答历史、宏与各样设置。
 */

/** 结构读取端口（宿主 = Memory 的表格/字段服务）。 */
export interface SpaceStructureReader {
  readonly listTables: (memorySpaceId: MemorySpaceId) => Promise<readonly MemoryTable[]>;
  readonly listFields: (
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTable["id"],
  ) => Promise<readonly MemoryField[]>;
}

export async function captureSpaceStructure(
  reader: SpaceStructureReader,
  memorySpaceId: MemorySpaceId,
  prompt?: string,
): Promise<TablePresetStructure> {
  const tables = await reader.listTables(memorySpaceId);
  const tableKeyById = new Map<string, string>(tables.map((table) => [table.id, table.key]));
  const fieldsByTableId = new Map<string, readonly MemoryField[]>();
  for (const table of tables) {
    fieldsByTableId.set(table.id, await reader.listFields(memorySpaceId, table.id));
  }

  return {
    prompt,
    tables: tables.map((table) => {
      const fields = fieldsByTableId.get(table.id) ?? [];
      const fieldKeyById = new Map<string, string>(fields.map((field) => [field.id, field.key]));
      return {
        key: table.key,
        name: table.name,
        description: table.description,
        prompt: table.prompt,
        enabled: table.enabled,
        vectorIndex: capturePresetVectorIndex(table.vectorIndex, fields),
        displayStrategy: captureDisplayStrategy(table.displayStrategy, fieldKeyById),
        fields: fields.map((field): TablePresetTable["fields"][number] => ({
          key: field.key,
          name: field.name,
          type: field.type,
          required: field.required,
          prompt: field.prompt,
          enabled: field.enabled,
          options: field.options,
          referenceTableKey: field.referenceTableId
            ? (tableKeyById.get(field.referenceTableId) ?? null)
            : null,
          maxChars: field.maxChars,
          valuePattern: field.valuePattern,
          valuePatternMessage: field.valuePatternMessage,
        })),
      };
    }),
  };
}

/**
 * 显示策略捕获：字段 ID → 字段 Key。字段已从表内删除（定义漂移）时策略无法用
 * Key 表达：按「无显示策略」捕获（该表在预设立场同样没有可用显示字段），
 * 不写入悬空 Key。
 */
function captureDisplayStrategy(
  strategy: MemoryTable["displayStrategy"],
  fieldKeyById: ReadonlyMap<string, string>,
): TablePresetDisplayStrategy | null {
  if (!strategy) return null;
  if (strategy.type === "field") {
    const fieldKey = fieldKeyById.get(strategy.fieldId);
    return fieldKey ? { type: "field", fieldKey } : null;
  }
  const template = strategy.template.replace(/\{([^{}]+)\}/g, (placeholder, fieldId: string) => {
    const fieldKey = fieldKeyById.get(fieldId);
    return fieldKey ? `{${fieldKey}}` : placeholder;
  });
  return { type: "template", template };
}
