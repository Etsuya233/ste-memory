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
  | "characters"
  | "relationships"
  | "locations"
  | "items"
  | "plots"
  | "foreshadowing"
  | "todos"
  | "story_state";

interface FieldTemplate {
  readonly key: string;
  readonly name: string;
  readonly type: MemoryFieldType;
  readonly required: boolean;
  readonly prompt: string;
  readonly options: readonly string[];
  readonly referenceTableKey: SystemMemoryTableKey | null;
  /** 文本类字段值长度上限（字符数）；null 表示不限。 */
  readonly maxChars: number | null;
  /** 文本类字段非空值的格式校验正则；null 表示不校验。 */
  readonly valuePattern?: string | null;
  /** 格式校验失败时回喂 Agent 的错误说明（人类可读，含示例）。 */
  readonly valuePatternMessage?: string | null;
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
  maxChars: null,
} as const;

/** 时间坐标格式校验（v4：current_time / time_hint 共用，双轨）。
 * 优先绝对时间：消息/场景说明有明确日期时间（如「2025年5月14日 17:35」，
 * 场记头日历）时填年月日（可有时分/时分秒）；无具体日期时才用
 * 「第 N 天·时段」稳定相对坐标（N 为阿拉伯或中文数字，时段分隔符可选）。 */
const STORY_TIME_PATTERN =
  "^(?:20\\d{2}年\\d{1,2}月\\d{1,2}日(?:\\s*\\d{1,2}[:：]\\d{2}(?:[:：]\\d{2})?)?|第\\s*[0-9一二两三四五六七八九十]+\\s*天[·、]?.+)$";
const STORY_TIME_MESSAGE =
  "时间坐标二选一：有明确日期时填具体年月日（如：2025年5月14日 17:35）；否则填「第 N 天·时段」（如：第一天清晨），天数随剧情推进、跨入新的一天才 +1";

/**
 * v4 系统表模板（2026-08-06 数据库质量审查后重构，v4 世界状态表）：
 * 1. 删除垃圾桶字段（notes）与从未填写的字段（plots.special / start_time / end_time）；
 * 2. 时间字段双轨坐标：有明确具体时间（场记头日历）时填「2025年5月14日 17:35」
 *    年月日时分，无具体日期时才用「第 N 天·时段」稳定相对坐标；
 * 3. items.current_status(long_text) 改为 status 枚举（物品状态是有界集合）；
 * 4. 全部文本字段有 maxChars 上限（校验层硬约束 + digest ≤N字 提示）；
 * 5. 事件唯一归位 plots，其他表只写稳定状态（表级 prompt 已写明）；
 * 6. plots.details 为追加式摘要（保留旧事实 + 追加新进展，允许润色不得删事实，
 *    maxChars 400→800 —— details 是未来 RAG/搜索的语料，覆盖式 = 有损压缩逐轮衰减）；
 * 7. v4 新增 story_state 世界状态表：承载剧情时钟（current_time）、
 *    当前地点、天气、当日着装；plots.time_hint 参照其 current_time，禁止「今天/当天」等相对词；
 * 8. v4 新增字段格式校验（value_pattern 正则 + 回喂消息）：current_time / time_hint 强制
 *    双轨时间格式（有明确日期填绝对年月日时分，否则第 N 天·时段），
 *    story_state.name 固定为「世界状态」——填错被拒 → 错误回喂 → 自愈重提。
 */
const SYSTEM_TABLE_TEMPLATES: readonly TableTemplate[] = [
  {
    key: "characters",
    name: "人物",
    description: "持续维护人物身份、特征、经历与当前状态。",
    prompt: TP.characters,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true, maxChars: 30 },
      { ...FIELD_DEFAULTS, key: "aliases", name: "别名", type: "short_text_list", maxChars: 30 },
      { ...FIELD_DEFAULTS, key: "role", name: "身份/定位", type: "short_text", maxChars: 50, prompt: "一句话身份（如：学长/学生、发小/同班）；不写性格与经历。" },
      {
        ...FIELD_DEFAULTS,
        key: "personality",
        name: "性格特征",
        type: "long_text",
        maxChars: 300,
        prompt: "本字段只记录稳定显著的个性特质，每条一句，合并同类项；不记录具体事件、台词、场景；每次更新压缩旧内容，总长不超过 300 字。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "appearance",
        name: "外貌特征",
        type: "long_text",
        maxChars: 300,
        prompt: "本字段只记录长期不变的外貌；不写当日穿着、临时配饰、事件性变化（变化进当前状态）；总长不超过 300 字。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "background",
        name: "背景/经历",
        type: "long_text",
        maxChars: 300,
        prompt: "本字段只记录相识前或长期经历的事实；与身份、当前状态不重叠；总长不超过 300 字。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_status",
        name: "当前状态",
        type: "long_text",
        maxChars: 200,
        prompt: FP.currentStatus,
      },
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
        key: "summary",
        name: "关系定性",
        type: "long_text",
        maxChars: 200,
        prompt: "本字段只记录双方关系的稳定定性（称呼、相处模式、地位），可体现方向不同的态度；不写事件过程；总长不超过 200 字。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_status",
        name: "当前状态",
        type: "long_text",
        maxChars: 200,
        prompt: FP.currentStatus,
      },
      {
        ...FIELD_DEFAULTS,
        key: "key_facts",
        name: "关键事实",
        type: "long_text",
        maxChars: 300,
        prompt: "本字段只记录关系的里程碑与长期事实（如：已同居、已发生关系、昵称约定）；不写事件流水；总长不超过 300 字。",
      },
    ],
  },
  {
    key: "locations",
    name: "地点",
    description: "维护地点属性、位置文本、状态及关联对象。",
    prompt: TP.locations,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true, maxChars: 30 },
      { ...FIELD_DEFAULTS, key: "type", name: "地点类型", type: "short_text", maxChars: 30, prompt: "如：宿舍/住所、食堂/餐厅、商店。" },
      {
        ...FIELD_DEFAULTS,
        key: "details",
        name: "固定描述",
        type: "long_text",
        maxChars: 200,
        prompt: "本字段只记录地点的固定描述（布局、环境、相对位置）；不含事件；总长不超过 200 字。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_status",
        name: "当前状态",
        type: "long_text",
        maxChars: 200,
        prompt: "本字段只记录此刻在此地点正在发生什么（一两句）；事件结束后清空；禁止过程叙述。",
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
    ],
  },
  {
    key: "items",
    name: "物品",
    description: "维护物品类型、归属、位置、状态与关键属性。",
    prompt: TP.items,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true, maxChars: 30 },
      { ...FIELD_DEFAULTS, key: "type", name: "物品类型", type: "short_text", maxChars: 30, prompt: "如：眼镜、自行车、食材。" },
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
        key: "status",
        name: "状态",
        type: "single_select",
        options: ["可用", "已消耗", "已丢失", "已赠出"],
        prompt: "本字段只记录物品当前状态；不写使用历史与事件过程。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "key_attributes",
        name: "关键属性",
        type: "long_text",
        maxChars: 200,
        prompt: "本字段只记录物品固定属性（材质、规格、外观、来源）；不写使用历史；总长不超过 200 字。",
      },
    ],
  },
  {
    key: "plots",
    name: "剧情",
    description: "维护持续发展的剧情事件及其参与对象和状态。",
    prompt: TP.plots,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true, maxChars: 30, prompt: "简洁事件名，不写括号解释。" },
      {
        ...FIELD_DEFAULTS,
        key: "details",
        name: "进度摘要",
        type: "long_text",
        maxChars: 800,
        prompt:
          "本字段是事件持续累积的进度摘要：保留已有事实，追加本轮新进展；允许润色措辞使总长不超过 800 字，但不得删除已记录的事实；禁止全文转写对话。",
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
      {
        ...FIELD_DEFAULTS,
        key: "time_hint",
        name: "发生时间",
        type: "short_text",
        maxChars: 30,
        prompt: FP.timeHint,
        valuePattern: STORY_TIME_PATTERN,
        valuePatternMessage: STORY_TIME_MESSAGE,
      },
    ],
  },
  {
    key: "foreshadowing",
    name: "伏笔",
    description: "维护尚未闭环的叙事线索及其计划回收信息。",
    prompt: TP.foreshadowing,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true, maxChars: 30 },
      {
        ...FIELD_DEFAULTS,
        key: "setup",
        name: "线索",
        type: "long_text",
        maxChars: 200,
        prompt: "本字段只记录线索本身（什么还没闭环），一两句话；不写事件经过；总长不超过 200 字。",
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
        maxChars: 200,
        prompt: "本字段只记录证据暗示或明确提出的回收线索；不写事件经过；总长不超过 200 字。",
      },
    ],
  },
  {
    key: "todos",
    name: "待办",
    description: "维护明确提出且尚需执行的行动事项。",
    prompt: TP.todos,
    fields: [
      { ...FIELD_DEFAULTS, key: "name", name: "名称", type: "short_text", required: true, maxChars: 30 },
      {
        ...FIELD_DEFAULTS,
        key: "details",
        name: "行动内容",
        type: "long_text",
        maxChars: 150,
        prompt: "本字段只记录要做什么（谁、做什么）；不写背景经过；完成或放弃后清空；总长不超过 150 字。",
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
        key: "relative_due",
        name: "期望时间",
        type: "short_text",
        maxChars: 30,
        prompt: "本字段只记录相对截止时间（如：今晚/周末）；无信息则留空。",
      },
    ],
  },
  {
    key: "story_state",
    name: "世界状态",
    description: "维护剧情世界的当前状态快照（时间、地点、天气、服装）；全表仅一条记录，覆盖式更新。",
    prompt: TP.storyState,
    fields: [
      {
        ...FIELD_DEFAULTS,
        key: "name",
        name: "名称",
        type: "short_text",
        required: true,
        maxChars: 30,
        prompt: "固定填「世界状态」；本表只维护一条记录。",
        valuePattern: "^世界状态$",
        valuePatternMessage: "本表名称固定为「世界状态」",
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_time",
        name: "当前时间",
        type: "short_text",
        maxChars: 30,
        prompt: FP.storyTime,
        valuePattern: STORY_TIME_PATTERN,
        valuePatternMessage: STORY_TIME_MESSAGE,
      },
      {
        ...FIELD_DEFAULTS,
        key: "current_location",
        name: "当前地点",
        type: "short_text",
        maxChars: 30,
        prompt: "本字段只记录主要角色当前所在（如：宿舍客厅、超市收银台）；多人分处时简写各自位置；无信息则留空。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "weather",
        name: "天气",
        type: "short_text",
        maxChars: 30,
        prompt: "本字段只记录当前天气（如：晴/多云/雨/雪）；无信息则留空。",
      },
      {
        ...FIELD_DEFAULTS,
        key: "clothing",
        name: "当日着装",
        type: "short_text",
        maxChars: 60,
        prompt: "本字段只记录主要角色当日着装要点（谁穿了什么，一两句）；不记录长期配饰（进物品表）；无信息则留空。",
      },
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
            maxChars: field.maxChars,
            valuePattern: field.valuePattern ?? null,
            valuePatternMessage: field.valuePatternMessage ?? null,
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
