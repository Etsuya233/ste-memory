import { migrateMemoryViews, parseMemoryMacros } from "../macros/macro-expression.ts";
import type { LegacySnapshot, SnapshotV1 } from "./snapshot-schema.ts";

/** 旧外壳→v1：视图转宏、补初始化来源/表顺序/向量组key，删除kind及空孤立证据键。保留已有台账。 */
export function upgradeLegacySnapshotToV1(
  legacy: LegacySnapshot,
  version: "legacy-views" | "legacy-macros",
): SnapshotV1 {
  const { chatScopeMacros, ...content } = legacy;
  const macros =
    legacy.space.macros ??
    (version === "legacy-views"
      ? migrateMemoryViews(chatScopeMacros ?? [], `legacy-backup:${legacy.space.id}`)
      : parseMemoryMacros(chatScopeMacros ?? []));
  const fieldTable = new Map(legacy.fields.map((field) => [field.id, field.tableId]));
  return {
    ...content,
    schemaVersion: 1,
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
