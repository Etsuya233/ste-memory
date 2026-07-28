import type {
  MemoryField,
  MemoryFieldId,
  MemoryFieldType,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
  SystemMemoryTableKey,
} from "../domain/index.ts";
import {
  SYSTEM_FIELD_PROMPTS as FP,
  SYSTEM_TABLE_PROMPTS as TP,
} from "./system-memory-table-prompts.ts";

interface FieldTemplate {
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly referenceTableKey: SystemMemoryTableKey | null;
}

interface TableTemplate {
  readonly key: SystemMemoryTableKey;
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  readonly fields: readonly FieldTemplate[];
}

const NONE: readonly string[] = [];
const FIELD_DEFAULTS = {
  required: false,
  prompt: "",
  options: NONE,
  referenceTableKey: null,
} as const;

const SYSTEM_TABLE_TEMPLATES: readonly TableTemplate[] = [
  {
    key: "characters",
    name: "人物",
    description: "持续维护人物身份、特征、经历与当前状态。",
    prompt: TP.characters,
    fields: [
      { ...FIELD_DEFAULTS, name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, name: "别名", type: "short_text_list" },
      { ...FIELD_DEFAULTS, name: "身份/定位", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "性格特征", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "外貌特征", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "背景/经历", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "当前状态", type: "long_text", prompt: FP.currentStatus },
      { ...FIELD_DEFAULTS, name: "备注", type: "long_text" },
    ],
  },
  {
    key: "relationships",
    name: "人际关系",
    description: "维护人物对之间的关系认知、现状与关键事实。",
    prompt: TP.relationships,
    fields: [
      {
        ...FIELD_DEFAULTS,
        name: "人物 A",
        type: "single_reference",
        required: true,
        prompt: FP.relationshipCharacterA,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        name: "人物 B",
        type: "single_reference",
        required: true,
        prompt: FP.relationshipCharacterB,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        name: "关系描述",
        type: "long_text",
        prompt: FP.relationshipDescription,
      },
      { ...FIELD_DEFAULTS, name: "当前状态", type: "long_text", prompt: FP.currentStatus },
      { ...FIELD_DEFAULTS, name: "关键事实", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "备注", type: "long_text" },
    ],
  },
  {
    key: "locations",
    name: "地点",
    description: "维护地点属性、位置文本、状态及关联对象。",
    prompt: TP.locations,
    fields: [
      { ...FIELD_DEFAULTS, name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, name: "地点类型", type: "short_text" },
      { ...FIELD_DEFAULTS, name: "详细地点文本", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "当前状态", type: "long_text", prompt: FP.currentStatus },
      {
        ...FIELD_DEFAULTS,
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        name: "相关物品",
        type: "multi_reference",
        prompt: FP.relatedItems,
        referenceTableKey: "items",
      },
      { ...FIELD_DEFAULTS, name: "备注", type: "long_text" },
    ],
  },
  {
    key: "items",
    name: "物品",
    description: "维护物品类型、归属、位置、状态与关键属性。",
    prompt: TP.items,
    fields: [
      { ...FIELD_DEFAULTS, name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, name: "物品类型", type: "short_text" },
      {
        ...FIELD_DEFAULTS,
        name: "持有者/所属人物",
        type: "single_reference",
        prompt: FP.holder,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        name: "当前位置",
        type: "single_reference",
        prompt: FP.currentLocation,
        referenceTableKey: "locations",
      },
      { ...FIELD_DEFAULTS, name: "状态", type: "long_text", prompt: FP.currentStatus },
      { ...FIELD_DEFAULTS, name: "关键属性", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "备注", type: "long_text" },
    ],
  },
  {
    key: "plots",
    name: "剧情",
    description: "维护持续发展的剧情线程及其参与对象和状态。",
    prompt: TP.plots,
    fields: [
      { ...FIELD_DEFAULTS, name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, name: "详情", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        name: "相关地点",
        type: "multi_reference",
        prompt: FP.relatedLocations,
        referenceTableKey: "locations",
      },
      {
        ...FIELD_DEFAULTS,
        name: "状态",
        type: "single_select",
        prompt: FP.plotStatus,
        options: ["进行中", "暂停", "已解决", "已放弃"],
      },
      { ...FIELD_DEFAULTS, name: "备注", type: "long_text" },
    ],
  },
  {
    key: "foreshadowing",
    name: "伏笔",
    description: "维护尚未闭环的叙事线索及其计划回收信息。",
    prompt: TP.foreshadowing,
    fields: [
      { ...FIELD_DEFAULTS, name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, name: "详情", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        name: "相关地点",
        type: "multi_reference",
        prompt: FP.relatedLocations,
        referenceTableKey: "locations",
      },
      {
        ...FIELD_DEFAULTS,
        name: "状态",
        type: "single_select",
        prompt: FP.foreshadowingStatus,
        options: ["埋设中", "已触发", "已回收", "已放弃"],
      },
      { ...FIELD_DEFAULTS, name: "计划回收信息", type: "long_text" },
      { ...FIELD_DEFAULTS, name: "备注", type: "long_text" },
    ],
  },
  {
    key: "todos",
    name: "待办",
    description: "维护明确提出且尚需执行的行动事项。",
    prompt: TP.todos,
    fields: [
      { ...FIELD_DEFAULTS, name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, name: "详情", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        name: "相关地点",
        type: "multi_reference",
        prompt: FP.relatedLocations,
        referenceTableKey: "locations",
      },
      { ...FIELD_DEFAULTS, name: "优先级", type: "single_select", options: ["高", "中", "低"] },
      {
        ...FIELD_DEFAULTS,
        name: "状态",
        type: "single_select",
        prompt: FP.todoStatus,
        options: ["待处理", "进行中", "已完成", "已放弃"],
      },
      { ...FIELD_DEFAULTS, name: "截止日期", type: "date", prompt: FP.deadline },
      { ...FIELD_DEFAULTS, name: "备注", type: "long_text" },
    ],
  },
];

export interface SystemMemoryDefinitions {
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
}

export function createSystemMemoryDefinitions(
  memorySpaceId: MemorySpaceId,
  createTableId: () => MemoryTableId,
  createFieldId: () => MemoryFieldId,
  now: string,
): SystemMemoryDefinitions {
  const tableIds = new Map(
    SYSTEM_TABLE_TEMPLATES.map((template) => [template.key, createTableId()]),
  );
  const fieldsByTable = new Map<SystemMemoryTableKey, MemoryField[]>();
  const fields = SYSTEM_TABLE_TEMPLATES.flatMap((table) => {
    const tableFields = table.fields.map((field, position): MemoryField => ({
      id: createFieldId(),
      memorySpaceId,
      tableId: tableIds.get(table.key)!,
      name: field.name,
      type: field.type,
      required: field.required,
      prompt: field.prompt,
      enabled: true,
      position,
      options: field.options,
      referenceTableId: field.referenceTableKey ? tableIds.get(field.referenceTableKey)! : null,
      createdAt: now,
      updatedAt: now,
    }));
    fieldsByTable.set(table.key, tableFields);
    return tableFields;
  });
  const tables = SYSTEM_TABLE_TEMPLATES.map((template): MemoryTable => {
    const tableFields = fieldsByTable.get(template.key)!;
    return {
      id: tableIds.get(template.key)!,
      memorySpaceId,
      kind: "system",
      systemKey: template.key,
      name: template.name,
      description: template.description,
      prompt: template.prompt,
      enabled: true,
      displayStrategy:
        template.key === "relationships"
          ? { type: "template", template: `{${tableFields[0]!.id}} <-> {${tableFields[1]!.id}}` }
          : { type: "field", fieldId: tableFields[0]!.id },
      createdAt: now,
      updatedAt: now,
    };
  });
  return { tables, fields };
}
