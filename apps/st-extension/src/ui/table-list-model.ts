import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldType,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";

/** 12 种字段类型的显示名（表格列表与后续 ticket 09 字段编辑器共用） */
export const FIELD_TYPE_LABELS: Readonly<Record<MemoryFieldType, string>> = {
  short_text: "短文本",
  long_text: "长文本",
  short_text_list: "短文本列表",
  integer: "整数",
  decimal: "小数",
  boolean: "布尔",
  date: "日期",
  datetime: "日期时间",
  single_select: "单选",
  multi_select: "多选",
  single_reference: "单引用",
  multi_reference: "多引用",
};

export interface FieldItemViewModel {
  readonly id: MemoryFieldId;
  readonly key: string;
  readonly name: string;
  readonly typeLabel: string;
  readonly required: boolean;
  readonly enabled: boolean;
}

export interface TableListItemViewModel {
  readonly id: MemoryTableId;
  readonly key: string;
  readonly name: string;
  readonly kind: MemoryTable["kind"];
  readonly description: string;
  readonly enabled: boolean;
  readonly fields: readonly FieldItemViewModel[];
  /** 启用字段数（表格行「N/M 字段启用」统计） */
  readonly enabledFieldCount: number;
}

/**
 * 表格列表视图模型（纯函数）：表 + 按表分组的字段 → 展示形状。
 * 排序由服务保证（表 createdAt 升序、字段 position 升序），本函数不重排；
 * fieldsByTable 缺表的表 = 无字段（防御空映射）。
 */
export function buildTableListViewModel(
  tables: readonly MemoryTable[],
  fieldsByTable: ReadonlyMap<MemoryTableId, readonly MemoryField[]>,
): TableListItemViewModel[] {
  return tables.map((table) => {
    const fields = (fieldsByTable.get(table.id) ?? []).map((field) => ({
      id: field.id,
      key: field.key,
      name: field.name,
      typeLabel: FIELD_TYPE_LABELS[field.type],
      required: field.required,
      enabled: field.enabled,
    }));
    return {
      id: table.id,
      key: table.key,
      name: table.name,
      kind: table.kind,
      description: table.description,
      enabled: table.enabled,
      fields,
      enabledFieldCount: fields.filter((field) => field.enabled).length,
    };
  });
}
