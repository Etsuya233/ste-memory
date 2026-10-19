import { Type } from "typebox";
import type {
  MemoryEvidence,
  MemoryField,
  MemoryRecord,
  MemoryRecordHistory,
  MemorySpace,
  MemoryTable,
} from "../memory/index.ts";
import type { FillTask } from "../fill-tasks/fill-task.ts";
import type { MemoryView } from "../macros/memory-views.ts";

/**
 * 备份文件格式（ADR 0021）：全库序列化单元集合 + 信封。
 *
 * - 信封固定为 `{ format, version, exportedAt, appVersion, data }`；
 *   导入先校验 format/version，未知版本给出「文件版本不支持」明确错误。
 * - 每个记忆空间一个序列化单元（space/tables/fields/records/history/evidence
 *   + 填表任务、楼层进度与对话级宏快照），与 Dexie / SQLite 的存储形态一一对应，
 *   导出即行原样序列化。
 * - 领域 id 是 branded string，序列化后就是普通字符串；解码侧用
 *   `memoryBackupFileSchema`（TypeBox）做结构校验，另加 id 唯一性与
 *   归属一致性检查（见 backup-codec.ts 的 validateBackupData）。
 * - 三个可选集合（fillTasks / floorLedger / chatScopeMacros）对旧文件缺省：
 *   缺省表示「不涉及」，恢复时保持目标原有值（对话文件镜像不带它们，镜像恢复
 *   因此不触碰任务、进度与宏）；单空间导出与应用预设的备份会写全。
 */

export const BACKUP_FORMAT = "ste-memory-backup" as const;
export const BACKUP_VERSION = 1 as const;

/** 备份文件信封：format/version 固定，data 为全库快照。 */
export interface MemoryBackupFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly data: MemoryBackupData;
}

/** 全库快照：一个记忆空间一个序列化单元（备份 port 的 load/restore 载荷）。 */
export interface MemoryBackupData {
  readonly spaces: readonly MemorySpaceBackup[];
}

/** 楼层进度台账条目（untracked = 无行，不出现）。 */
export interface MemorySpaceBackupLedgerEntry {
  readonly floor: number;
  readonly status: "processed" | "error";
  readonly updatedAt: string;
}

/** 单个记忆空间的序列化单元。 */
export interface MemorySpaceBackup {
  readonly space: MemorySpace;
  readonly tables: readonly MemoryTable[];
  readonly fields: readonly MemoryField[];
  readonly records: readonly MemoryRecord[];
  readonly history: readonly MemoryRecordHistory[];
  readonly evidence: readonly MemoryEvidence[];
  /** 填表任务（缺省 = 不涉及：恢复保持目标原有任务） */
  readonly fillTasks?: readonly FillTask[];
  /** 楼层进度台账（缺省 = 不涉及） */
  readonly floorLedger?: readonly MemorySpaceBackupLedgerEntry[];
  /** 该对话的对话级宏快照（缺省 = 不涉及；随对话文件走，导出单空间时写入） */
  readonly chatScopeMacros?: readonly MemoryView[];
}

// ---------------------------------------------------------------------------
// TypeBox 结构校验 Schema：与领域类型一一对应，供导入前校验
// （信封校验 + 结构校验分离，结构错误路径可读）。
// ---------------------------------------------------------------------------

const timestampSchema = Type.String();

const memorySpaceInitializationSourceSchema = Type.Object({
  presetId: Type.String(),
  presetName: Type.String(),
  appliedAt: timestampSchema,
});

const memorySpaceSchema = Type.Object({
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

/** 对话级宏条目 schema（与 MemoryView 同构）。 */
const memoryViewSchema = Type.Object({
  name: Type.String(),
  tableKey: Type.String(),
  condition: Type.Union([
    Type.Object({ fieldKey: Type.String(), values: Type.Array(Type.String()) }),
    Type.Null(),
  ]),
  limit: Type.Union([Type.Number(), Type.Null()]),
  projection: Type.Array(Type.String()),
});

/** 单个记忆空间的序列化单元 schema（备份文件 data.spaces 元素；云同步文件 data 复用） */
export const memorySpaceBackupSchema = Type.Object({
  space: memorySpaceSchema,
  tables: Type.Array(memoryTableSchema),
  fields: Type.Array(memoryFieldSchema),
  records: Type.Array(memoryRecordSchema),
  history: Type.Array(memoryRecordHistorySchema),
  evidence: Type.Array(memoryEvidenceSchema),
  // 可选集合：旧文件没有这些键（不涉及），新导出写全
  fillTasks: Type.Optional(Type.Array(memorySpaceFillTaskSchema)),
  floorLedger: Type.Optional(Type.Array(memorySpaceLedgerEntrySchema)),
  chatScopeMacros: Type.Optional(Type.Array(memoryViewSchema)),
});

export const memoryBackupDataSchema = Type.Object({
  spaces: Type.Array(memorySpaceBackupSchema),
});

/** 完整备份文件信封 schema（导入前的结构校验）。 */
export const memoryBackupFileSchema = Type.Object({
  format: Type.Literal(BACKUP_FORMAT),
  version: Type.Literal(BACKUP_VERSION),
  exportedAt: Type.String(),
  appVersion: Type.String(),
  data: memoryBackupDataSchema,
});
