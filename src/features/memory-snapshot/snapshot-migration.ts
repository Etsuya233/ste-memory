import { Value } from "typebox/value";
import { Type, type Static, type TSchema } from "typebox";
import { migrateMemoryViews, parseMemoryMacros } from "../macros/macro-expression.ts";
import { legacyMemorySpaceSnapshotSchema, memorySpaceSnapshotSchema } from "./snapshot-schema.ts";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION, type MemorySpaceBackup } from "./snapshot.ts";
import { createSnapshotSeenIds, validateSnapshotIntegrity } from "./snapshot-integrity.ts";
import { snapshotInvalid } from "./snapshot-errors.ts";

/** 来源外壳负责辨认历史版本，迁移入口只接收明确版本，不根据缺字段猜测。 */
export type MemorySnapshotVersion =
  "legacy-views" | "legacy-macros" | 1 | typeof MEMORY_SNAPSHOT_SCHEMA_VERSION;

export function assertSnapshotStructure(schema: TSchema, value: unknown): void {
  if (Value.Check(schema, value)) {
    return;
  }
  const details = [...Value.Errors(schema, value)]
    .slice(0, 5)
    .map(
      (error) =>
        `${(error.instancePath || "文件顶层")
          .replace(/^\//, "")
          .replace(/\/(\d+)/g, "[$1]")
          .replaceAll("/", ".")}: ${error.message}`,
    )
    .join("；");
  snapshotInvalid(details);
}

/** 纯迁移：旧 ID、证据内容及历史保持原样；当前格式只校验，不重复迁移。 */
export function migrateMemorySpaceSnapshot(input: {
  readonly version: unknown;
  readonly snapshot: unknown;
}): MemorySpaceBackup {
  if (
    input.version !== MEMORY_SNAPSHOT_SCHEMA_VERSION &&
    input.version !== 1 &&
    input.version !== "legacy-views" &&
    input.version !== "legacy-macros"
  ) {
    snapshotInvalid(`快照版本不支持：${String(input.version)}`);
  }
  let snapshot = input.snapshot;
  if (input.version === 1) {
    const previousSchema = Type.Object({
      ...memorySpaceSnapshotSchema.properties,
      schemaVersion: Type.Literal(1),
      floorLedger: legacyMemorySpaceSnapshotSchema.properties.floorLedger,
    });
    assertSnapshotStructure(previousSchema, snapshot);
    const previous = snapshot as { readonly floorLedger?: MemorySpaceBackup["floorLedger"] };
    snapshot = {
      ...(snapshot as Record<string, unknown>),
      schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
      // 只采用文件自身携带的进度；缺失时保持未知，绝不读取本机旧台账。
      floorLedger: previous.floorLedger ?? [],
    };
  } else if (input.version !== MEMORY_SNAPSHOT_SCHEMA_VERSION) {
    assertSnapshotStructure(legacyMemorySpaceSnapshotSchema, snapshot);
    const legacy = snapshot as Static<typeof legacyMemorySpaceSnapshotSchema>;
    // 旧外壳没有领域版本标记，拒绝把未知或伪装成旧文件的新版本当旧数据修补。
    if ("schemaVersion" in legacy) {
      snapshotInvalid("旧格式快照不应含 schemaVersion");
    }
    snapshot = upgradeLegacySnapshot(legacy, input.version);
  }
  assertSnapshotStructure(memorySpaceSnapshotSchema, snapshot);
  // ID 在 JSON 中是字符串；结构校验后恢复领域品牌，完整性校验再检查归属与引用。
  const current = snapshot as MemorySpaceBackup;
  validateSnapshotIntegrity(current, createSnapshotSeenIds());
  return current;
}

type LegacySnapshot = Static<typeof legacyMemorySpaceSnapshotSchema>;

function upgradeLegacySnapshot(
  legacy: LegacySnapshot,
  version: "legacy-views" | "legacy-macros",
): unknown {
  const { chatScopeMacros, ...content } = legacy;
  const macros =
    legacy.space.macros ??
    (version === "legacy-views"
      ? migrateMemoryViews(chatScopeMacros ?? [], `legacy-backup:${legacy.space.id}`)
      : parseMemoryMacros(chatScopeMacros ?? []));
  const fieldTable = new Map(legacy.fields.map((field) => [field.id, field.tableId]));
  return {
    ...content,
    schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
    floorLedger: legacy.floorLedger ?? [],
    space: {
      ...legacy.space,
      initializationSource: legacy.space.initializationSource ?? null,
      macros,
    },
    tables: legacy.tables.map(({ kind: _kind, ...table }, index) => ({
      ...table,
      position: table.position ?? index,
      vectorIndex: table.vectorIndex && {
        ...table.vectorIndex,
        groups: table.vectorIndex.groups.map((group) => ({ ...group, key: group.key ?? group.id })),
        presetGroups: table.vectorIndex.presetGroups?.map((group) => ({
          ...group,
          key: group.key ?? group.id,
        })),
      },
    })),
    // 旧字段删除会留下空证据键。仅移除当前记录中不携带证据的残留；非空仍由校验拒绝。
    // 历史按归档时的字段解释，保留其旧键，避免改写过去的字段状态。
    records: legacy.records.map((record) => ({
      ...record,
      fieldEvidence: Object.fromEntries(
        Object.entries(record.fieldEvidence).filter(
          ([fieldId, entries]) => fieldTable.get(fieldId) === record.tableId || entries.length > 0,
        ),
      ),
    })),
  };
}
