import { Type, type Static } from "typebox";
import { memoryMacroSchema } from "../macros/macro-expression.ts";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "./snapshot.ts";

const timestampSchema = Type.String();

const memorySpaceInitializationSourceSchema = Type.Object({
  presetId: Type.String(),
  presetName: Type.String(),
  appliedAt: timestampSchema,
});

const memorySpaceSchema = Type.Object({
  macros: Type.Optional(Type.Array(memoryMacroSchema)),
  prompt: Type.Optional(Type.String()),
  id: Type.String(),
  name: Type.String(),
  // 表格预设之前的备份文件（v1 早期）没有该键：解码时归一化为 null
  // （「初始化来源未记录」），新导出总是写出该键。
  initializationSource: Type.Optional(
    Type.Union([memorySpaceInitializationSourceSchema, Type.Null()]),
  ),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const memoryTableSchema = Type.Object({
  kind: Type.Optional(Type.Unknown()),
  vectorIndex: Type.Optional(
    Type.Object({
      enabled: Type.Boolean(),
      source: Type.Union([
        Type.Literal("automatic"),
        Type.Literal("preset"),
        Type.Literal("custom"),
      ]),
      updateMode: Type.Union([Type.Literal("manual"), Type.Literal("automatic")]),
      groups: Type.Array(
        Type.Object({
          id: Type.String(),
          key: Type.Optional(Type.String()),
          name: Type.String(),
          fieldIds: Type.Array(Type.String()),
        }),
      ),
      presetGroups: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            key: Type.Optional(Type.String()),
            name: Type.String(),
            fieldIds: Type.Array(Type.String()),
          }),
        ),
      ),
    }),
  ),
  id: Type.String(),
  memorySpaceId: Type.String(),
  key: Type.String(),
  name: Type.String(),
  description: Type.String(),
  prompt: Type.String(),
  enabled: Type.Boolean(),
  /** 空间内显式顺序；旧备份文件没有该键，解码时按数组顺序补齐 */
  position: Type.Optional(Type.Number()),
  displayStrategy: Type.Union([
    Type.Object({ type: Type.Literal("field"), fieldId: Type.String() }),
    Type.Object({ type: Type.Literal("template"), template: Type.String() }),
    Type.Null(),
  ]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const memoryFieldTypeSchema = Type.Union([
  Type.Literal("short_text"),
  Type.Literal("long_text"),
  Type.Literal("short_text_list"),
  Type.Literal("integer"),
  Type.Literal("decimal"),
  Type.Literal("boolean"),
  Type.Literal("date"),
  Type.Literal("datetime"),
  Type.Literal("single_select"),
  Type.Literal("multi_select"),
  Type.Literal("single_reference"),
  Type.Literal("multi_reference"),
]);

const memoryFieldSchema = Type.Object({
  id: Type.String(),
  memorySpaceId: Type.String(),
  tableId: Type.String(),
  key: Type.String(),
  name: Type.String(),
  type: memoryFieldTypeSchema,
  required: Type.Boolean(),
  prompt: Type.String(),
  enabled: Type.Boolean(),
  position: Type.Number(),
  options: Type.Array(Type.String()),
  referenceTableId: Type.Union([Type.String(), Type.Null()]),
  maxChars: Type.Union([Type.Number(), Type.Null()]),
  valuePattern: Type.Union([Type.String(), Type.Null()]),
  valuePatternMessage: Type.Union([Type.String(), Type.Null()]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const memoryFieldValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Array(Type.String()),
]);

const memoryPayloadSchema = Type.Record(Type.String(), memoryFieldValueSchema);

const memoryEvidenceSchema = Type.Union([
  Type.Object({
    evidence_id: Type.String(),
    source_type: Type.String(),
    source_id: Type.Union([Type.String(), Type.Number()]),
    storage_mode: Type.Literal("snapshot"),
    content: Type.String(),
    extraProps: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    evidence_id: Type.String(),
    source_type: Type.String(),
    source_id: Type.Union([Type.String(), Type.Number()]),
    storage_mode: Type.Literal("reference"),
    extraProps: Type.Record(Type.String(), Type.Unknown()),
  }),
]);

const memoryFieldEvidenceSchema = Type.Record(Type.String(), Type.Array(memoryEvidenceSchema));

const memoryRecordSourceSchema = Type.Union([
  Type.Object({ type: Type.Literal("manual") }),
  Type.Object({
    type: Type.Literal("source"),
    sourceTime: Type.Union([Type.String(), Type.Null()]),
    sourceLocation: Type.Union([Type.String(), Type.Null()]),
  }),
]);

const memoryRevisionSourceSchema = Type.Union([Type.Literal("agent"), Type.Literal("user")]);

const memoryRecordSchema = Type.Object({
  id: Type.String(),
  memorySpaceId: Type.String(),
  tableId: Type.String(),
  payload: memoryPayloadSchema,
  fieldEvidence: memoryFieldEvidenceSchema,
  displayText: Type.String(),
  source: memoryRecordSourceSchema,
  revisionId: Type.String(),
  revisionSource: memoryRevisionSourceSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const memoryRecordHistorySchema = Type.Object({
  id: Type.String(),
  recordId: Type.String(),
  memorySpaceId: Type.String(),
  tableId: Type.String(),
  payload: memoryPayloadSchema,
  fieldEvidence: memoryFieldEvidenceSchema,
  displayText: Type.String(),
  source: memoryRecordSourceSchema,
  previousRevisionId: Type.String(),
  previousRevisionSource: memoryRevisionSourceSchema,
  revisionId: Type.String(),
  revisionSource: memoryRevisionSourceSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema,
});

/** 单空间备份单元里的填表任务行 schema（与 FillTask 领域类型同构）。 */
const memorySpaceFillTaskSchema = Type.Object({
  automatic: Type.Optional(Type.Boolean()),
  queuePosition: Type.Optional(Type.Number()),
  blocksQueue: Type.Optional(Type.Boolean()),
  retryPolicy: Type.Optional(Type.Object({ retries: Type.Number(), delaySeconds: Type.Number() })),
  interruptionReason: Type.Optional(Type.Literal("chat-changed")),
  runId: Type.String(),
  memorySpaceId: Type.String(),
  from: Type.Number(),
  to: Type.Number(),
  blockSize: Type.Number(),
  kind: Type.Union([Type.Literal("floor"), Type.Literal("init")]),
  initText: Type.Union([Type.String(), Type.Null()]),
  chatId: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("interrupted"),
  ]),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** 楼层进度台账条目 schema（untracked 不物化）。 */
const memorySpaceLedgerEntrySchema = Type.Object({
  floor: Type.Number(),
  status: Type.Union([Type.Literal("processed"), Type.Literal("error")]),
  updatedAt: timestampSchema,
});

/** 单个记忆空间的序列化单元 schema（备份文件 data.spaces 元素；云同步文件 data 复用） */
export const legacyMemorySpaceSnapshotSchema = Type.Object({
  space: memorySpaceSchema,
  tables: Type.Array(memoryTableSchema),
  fields: Type.Array(memoryFieldSchema),
  records: Type.Array(memoryRecordSchema),
  history: Type.Array(memoryRecordHistorySchema),
  evidence: Type.Array(memoryEvidenceSchema),
  // 可选集合：旧文件没有这些键（不涉及），新导出写全
  fillTasks: Type.Optional(Type.Array(memorySpaceFillTaskSchema)),
  floorLedger: Type.Optional(Type.Array(memorySpaceLedgerEntrySchema)),
  chatScopeMacros: Type.Optional(Type.Array(Type.Unknown())),
});

// v1 固定的向量结构：组 key 必填，后续版本沿用该结构。
const snapshotV1VectorGroupSchema = Type.Object({
  id: Type.String(),
  key: Type.String(),
  name: Type.String(),
  fieldIds: Type.Array(Type.String()),
});
const snapshotV1VectorIndexSchema = Type.Object({
  enabled: Type.Boolean(),
  source: Type.Union([Type.Literal("automatic"), Type.Literal("preset"), Type.Literal("custom")]),
  updateMode: Type.Union([Type.Literal("manual"), Type.Literal("automatic")]),
  groups: Type.Array(snapshotV1VectorGroupSchema),
  presetGroups: Type.Optional(Type.Array(snapshotV1VectorGroupSchema)),
});
/** legacy→v1：宏与初始化来源必填、表位置与组 key 必填，禁止 kind/chatScopeMacros。 */
export const memorySpaceSnapshotV1Schema = Type.Object({
  ...legacyMemorySpaceSnapshotSchema.properties,
  schemaVersion: Type.Literal(1),
  space: Type.Object({
    ...memorySpaceSchema.properties,
    macros: Type.Array(memoryMacroSchema),
    initializationSource: Type.Union([memorySpaceInitializationSourceSchema, Type.Null()]),
  }),
  tables: Type.Array(
    Type.Object({
      ...memoryTableSchema.properties,
      kind: Type.Optional(Type.Never()),
      position: Type.Number(),
      vectorIndex: Type.Optional(snapshotV1VectorIndexSchema),
    }),
  ),
  chatScopeMacros: Type.Optional(Type.Never()),
});

/** v2 唯一新增约束：floorLedger 必填，空数组表示进度未知。 */
export const memorySpaceSnapshotV2Schema = Type.Object({
  ...memorySpaceSnapshotV1Schema.properties,
  schemaVersion: Type.Literal(2),
  floorLedger: Type.Array(memorySpaceLedgerEntrySchema),
});

/** v3 新增空间、当前记录及历史记录的稳定身份，其他结构沿用固定的 v2。 */
export const memorySpaceSnapshotSchema = Type.Object({
  ...memorySpaceSnapshotV2Schema.properties,
  schemaVersion: Type.Literal(MEMORY_SNAPSHOT_SCHEMA_VERSION),
  space: Type.Object({
    ...memorySpaceSnapshotV2Schema.properties.space.properties,
    stableId: Type.String({ minLength: 1 }),
  }),
  records: Type.Array(
    Type.Object({ ...memoryRecordSchema.properties, stableId: Type.String({ minLength: 1 }) }),
  ),
  history: Type.Array(
    Type.Object({
      ...memoryRecordHistorySchema.properties,
      stableId: Type.String({ minLength: 1 }),
    }),
  ),
});

// 迁移只读取输入；序列化字段与 schema 一致，集合无需具备可变能力。
type SnapshotData<T> = { readonly [K in keyof T]: SnapshotData<T[K]> };

export type LegacySnapshot = SnapshotData<Static<typeof legacyMemorySpaceSnapshotSchema>>;
export type SnapshotV1 = SnapshotData<Static<typeof memorySpaceSnapshotV1Schema>>;
export type SnapshotV2 = SnapshotData<Static<typeof memorySpaceSnapshotV2Schema>>;
export type SnapshotV3 = SnapshotData<Static<typeof memorySpaceSnapshotSchema>>;
