import type {
  MemoryFieldUseCases,
  MemoryFieldType,
  MemoryField,
  MemorySpaceId,
  MemoryTable,
  MemoryTableUseCases,
} from "@ste-memory/core/memory";
import {
  SYSTEM_FIELD_PROMPTS as FP,
  SYSTEM_TABLE_PROMPTS as TP,
} from "./system-memory-table-prompts.ts";

export type SystemMemoryTableKey =
  "characters" | "relationships" | "locations" | "items" | "plots" | "foreshadowing" | "todos";

interface FieldTemplate {
  readonly key: string;
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
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, key: "aliases", name: "别名", type: "short_text_list" },
      { ...FIELD_DEFAULTS, key: "role", name: "身份/定位", type: "long_text" },
      { ...FIELD_DEFAULTS, key: "personality", name: "性格特征", type: "long_text" },
      { ...FIELD_DEFAULTS, key: "appearance", name: "外貌特征", type: "long_text" },
      { ...FIELD_DEFAULTS, key: "background", name: "背景/经历", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        key: "current_status",
        name: "当前状态",
        type: "long_text",
        prompt: FP.currentStatus,
      },
      { ...FIELD_DEFAULTS, key: "notes", name: "备注", type: "long_text" },
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
        key: "character_a",
        name: "人物 A",
        type: "single_reference",
        required: true,
        prompt: FP.relationshipCharacterA,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        key: "character_b",
        name: "人物 B",
        type: "single_reference",
        required: true,
        prompt: FP.relationshipCharacterB,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        key: "description",
        name: "关系描述",
        type: "long_text",
        prompt: FP.relationshipDescription,
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_status",
        name: "当前状态",
        type: "long_text",
        prompt: FP.currentStatus,
      },
      { ...FIELD_DEFAULTS, key: "key_facts", name: "关键事实", type: "long_text" },
      { ...FIELD_DEFAULTS, key: "notes", name: "备注", type: "long_text" },
    ],
  },
  {
    key: "locations",
    name: "地点",
    description: "维护地点属性、位置文本、状态及关联对象。",
    prompt: TP.locations,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, key: "type", name: "地点类型", type: "short_text" },
      { ...FIELD_DEFAULTS, key: "details", name: "详细地点文本", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        key: "current_status",
        name: "当前状态",
        type: "long_text",
        prompt: FP.currentStatus,
      },
      {
        ...FIELD_DEFAULTS,
        key: "related_characters",
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        key: "related_items",
        name: "相关物品",
        type: "multi_reference",
        prompt: FP.relatedItems,
        referenceTableKey: "items",
      },
      { ...FIELD_DEFAULTS, key: "notes", name: "备注", type: "long_text" },
    ],
  },
  {
    key: "items",
    name: "物品",
    description: "维护物品类型、归属、位置、状态与关键属性。",
    prompt: TP.items,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, key: "type", name: "物品类型", type: "short_text" },
      {
        ...FIELD_DEFAULTS,
        key: "owner",
        name: "持有者/所属人物",
        type: "single_reference",
        prompt: FP.holder,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_location",
        name: "当前位置",
        type: "single_reference",
        prompt: FP.currentLocation,
        referenceTableKey: "locations",
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_status",
        name: "状态",
        type: "long_text",
        prompt: FP.currentStatus,
      },
      { ...FIELD_DEFAULTS, key: "key_attributes", name: "关键属性", type: "long_text" },
      { ...FIELD_DEFAULTS, key: "notes", name: "备注", type: "long_text" },
    ],
  },
  {
    key: "plots",
    name: "剧情",
    description: "维护持续发展的剧情线程及其参与对象和状态。",
    prompt: TP.plots,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, key: "details", name: "详情", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        key: "related_characters",
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        key: "related_locations",
        name: "相关地点",
        type: "multi_reference",
        prompt: FP.relatedLocations,
        referenceTableKey: "locations",
      },
      {
        ...FIELD_DEFAULTS,
        key: "status",
        name: "状态",
        type: "single_select",
        prompt: FP.plotStatus,
        options: ["进行中", "暂停", "已解决", "已放弃"],
      },
      { ...FIELD_DEFAULTS, key: "notes", name: "备注", type: "long_text" },
    ],
  },
  {
    key: "foreshadowing",
    name: "伏笔",
    description: "维护尚未闭环的叙事线索及其计划回收信息。",
    prompt: TP.foreshadowing,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, key: "details", name: "详情", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        key: "related_characters",
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        key: "related_locations",
        name: "相关地点",
        type: "multi_reference",
        prompt: FP.relatedLocations,
        referenceTableKey: "locations",
      },
      {
        ...FIELD_DEFAULTS,
        key: "status",
        name: "状态",
        type: "single_select",
        prompt: FP.foreshadowingStatus,
        options: ["埋设中", "已触发", "已回收", "已放弃"],
      },
      {
        ...FIELD_DEFAULTS,
        key: "resolution_plan",
        name: "计划回收信息",
        type: "long_text",
      },
      { ...FIELD_DEFAULTS, key: "notes", name: "备注", type: "long_text" },
    ],
  },
  {
    key: "todos",
    name: "待办",
    description: "维护明确提出且尚需执行的行动事项。",
    prompt: TP.todos,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true },
      { ...FIELD_DEFAULTS, key: "details", name: "详情", type: "long_text" },
      {
        ...FIELD_DEFAULTS,
        key: "related_characters",
        name: "相关人物",
        type: "multi_reference",
        prompt: FP.relatedCharacters,
        referenceTableKey: "characters",
      },
      {
        ...FIELD_DEFAULTS,
        key: "related_locations",
        name: "相关地点",
        type: "multi_reference",
        prompt: FP.relatedLocations,
        referenceTableKey: "locations",
      },
      {
        ...FIELD_DEFAULTS,
        key: "priority",
        name: "优先级",
        type: "single_select",
        options: ["高", "中", "低"],
      },
      {
        ...FIELD_DEFAULTS,
        key: "status",
        name: "状态",
        type: "single_select",
        prompt: FP.todoStatus,
        options: ["待处理", "进行中", "已完成", "已放弃"],
      },
      {
        ...FIELD_DEFAULTS,
        key: "due_date",
        name: "截止日期",
        type: "date",
        prompt: FP.deadline,
      },
      { ...FIELD_DEFAULTS, key: "notes", name: "备注", type: "long_text" },
    ],
  },
];

export class SystemMemoryTableInstaller {
  private readonly tables: MemoryTableUseCases;
  private readonly fields: MemoryFieldUseCases;

  constructor(tables: MemoryTableUseCases, fields: MemoryFieldUseCases) {
    this.tables = tables;
    this.fields = fields;
  }

  async install(memorySpaceId: MemorySpaceId): Promise<void> {
    const tablesByKey = new Map<SystemMemoryTableKey, MemoryTable>();
    for (const template of SYSTEM_TABLE_TEMPLATES) {
      tablesByKey.set(
        template.key,
        (await this.tables.create(memorySpaceId, {
          key: template.key,
          kind: "system",
          name: template.name,
          description: template.description,
          prompt: template.prompt,
        }))!,
      );
    }
    const fieldsByTable = new Map<SystemMemoryTableKey, MemoryField[]>();
    for (const table of SYSTEM_TABLE_TEMPLATES) {
      const fields: MemoryField[] = [];
      for (const [position, field] of table.fields.entries()) {
        fields.push(
          (await this.fields.create(memorySpaceId, tablesByKey.get(table.key)!.id, {
            key: field.key,
            name: field.name,
            type: field.type,
            required: field.required,
            prompt: field.prompt,
            enabled: true,
            position,
            options: field.options,
            referenceTableId: field.referenceTableKey
              ? tablesByKey.get(field.referenceTableKey)!.id
              : null,
          }))!,
        );
      }
      fieldsByTable.set(table.key, fields);
    }

    for (const template of SYSTEM_TABLE_TEMPLATES) {
      const table = tablesByKey.get(template.key)!;
      const fields = fieldsByTable.get(template.key)!;
      await this.fields.setDisplayStrategy(
        memorySpaceId,
        table.id,
        template.key === "relationships"
          ? { type: "template", template: `{${fields[0]!.id}} <-> {${fields[1]!.id}}` }
          : { type: "field", fieldId: fields[0]!.id },
      );
    }
  }
}
