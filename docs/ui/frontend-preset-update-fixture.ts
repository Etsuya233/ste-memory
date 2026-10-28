import type {
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordHistory,
  VectorIndexConfiguration,
} from "../../src/features/memory/index.ts";
import type { MemorySpaceBackup } from "../../src/features/backup/backup-file.ts";
import {
  buildPresetUpdate,
  previewPresetUpdate,
  type PresetSpaceUpdateService,
} from "../../src/features/table-presets/preset-space-update.ts";
import type { PresetInstantiationIds } from "../../src/features/table-presets/preset-instantiation.ts";

/** Legacy UI seeds reuse short field IDs across tables. Namespace them at the
 * domain boundary, then map surviving fields back for the existing preview APIs.
 * Newly created fields already have unique IDs and keep those IDs on publication.
 */
function domainUnit(source: MemorySpaceBackup) {
  const originalIds = new Map<MemoryFieldId, MemoryFieldId>();
  const fieldId = (tableId: string, id: string) =>
    `fixture:${JSON.stringify([tableId, id])}` as MemoryFieldId;
  for (const field of source.fields) originalIds.set(fieldId(field.tableId, field.id), field.id);
  const mapVector = (
    configuration: VectorIndexConfiguration | undefined,
    transform: (id: MemoryFieldId) => MemoryFieldId,
  ) =>
    configuration
      ? {
          ...configuration,
          groups: configuration.groups.map((group) => ({
            ...group,
            fieldIds: group.fieldIds.map(transform),
          })),
          ...(configuration.presetGroups
            ? {
                presetGroups: configuration.presetGroups.map((group) => ({
                  ...group,
                  fieldIds: group.fieldIds.map(transform),
                })),
              }
            : {}),
        }
      : configuration;
  const mapRecord = <T extends MemoryRecord | MemoryRecordHistory>(
    record: T,
    transform: (id: MemoryFieldId) => MemoryFieldId,
  ): T => ({
    ...record,
    payload: Object.fromEntries(
      Object.entries(record.payload).map(([id, value]) => [transform(id as MemoryFieldId), value]),
    ),
    fieldEvidence: Object.fromEntries(
      Object.entries(record.fieldEvidence).map(([id, value]) => [
        transform(id as MemoryFieldId),
        value,
      ]),
    ),
  });
  const mapTable = (
    table: MemorySpaceBackup["tables"][number],
    transform: (id: MemoryFieldId) => MemoryFieldId,
  ) => ({
    ...table,
    displayStrategy:
      table.displayStrategy?.type === "field"
        ? { ...table.displayStrategy, fieldId: transform(table.displayStrategy.fieldId) }
        : table.displayStrategy?.type === "template"
          ? {
              ...table.displayStrategy,
              template: table.displayStrategy.template.replace(
                /\{([^{}]+)\}/g,
                (_, id: MemoryFieldId) => `{${transform(id)}}`,
              ),
            }
          : null,
    vectorIndex: mapVector(table.vectorIndex, transform),
  });
  const unit: MemorySpaceBackup = {
    ...source,
    tables: source.tables.map((table) => mapTable(table, (id) => fieldId(table.id, id))),
    fields: source.fields.map((field) => ({ ...field, id: fieldId(field.tableId, field.id) })),
    records: source.records.map((record) => mapRecord(record, (id) => fieldId(record.tableId, id))),
    history: source.history.map((record) => mapRecord(record, (id) => fieldId(record.tableId, id))),
  };
  function publish(next: MemorySpaceBackup): MemorySpaceBackup {
    const original = (id: MemoryFieldId) => (originalIds.has(id) ? originalIds.get(id)! : id);
    return {
      ...next,
      tables: next.tables.map((table) => mapTable(table, original)),
      fields: next.fields.map((field) => ({ ...field, id: original(field.id) })),
      records: next.records.map((record) => mapRecord(record, original)),
      history: next.history.map((record) => mapRecord(record, original)),
    };
  }
  return { unit, publish };
}

export function createPresetUpdateFixture(options: {
  read: (spaceId: MemorySpaceBackup["space"]["id"]) => MemorySpaceBackup;
  write: (unit: MemorySpaceBackup) => void;
  assert: (spaceId: MemorySpaceBackup["space"]["id"], chatIdentity: string) => void;
  changed: () => Promise<void>;
  ids: PresetInstantiationIds;
}) {
  let previewDelay = 0;
  let applyDelay = 0;
  let resultDelay = 0;
  let syncFailure = false;
  const state = { previews: 0, applies: 0, retries: 0 };
  const service: PresetSpaceUpdateService = {
    preview: async (spaceId, preset, chatIdentity) => {
      options.assert(spaceId, chatIdentity);
      const snapshot = domainUnit(options.read(spaceId)).unit;
      const delay = previewDelay;
      previewDelay = 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      options.assert(spaceId, chatIdentity);
      state.previews++;
      return previewPresetUpdate(snapshot, preset);
    },
    apply: async (plan, selectedIds, chatIdentity) => {
      options.assert(plan.spaceId, chatIdentity);
      const delay = applyDelay;
      applyDelay = 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      options.assert(plan.spaceId, chatIdentity);
      const current = domainUnit(options.read(plan.spaceId));
      const next = buildPresetUpdate(
        current.unit,
        plan,
        selectedIds,
        options.ids,
        new Date().toISOString(),
      );
      options.write(current.publish(next));
      state.applies++;
      await options.changed();
      const resultWait = resultDelay;
      resultDelay = 0;
      if (resultWait) await new Promise((resolve) => setTimeout(resolve, resultWait));
      if (syncFailure) {
        syncFailure = false;
        return { issues: ["预览模拟：更新已提交，对话文件保存失败"] };
      }
      return { issues: [] };
    },
    retrySave: async (spaceId, chatIdentity) => {
      options.assert(spaceId, chatIdentity);
      state.retries++;
      await options.changed();
      return { issues: [] };
    },
  };
  return {
    service,
    state: () => structuredClone(state),
    delayPreview: (ms: number) => {
      previewDelay = ms;
    },
    delayApply: (ms: number) => {
      applyDelay = ms;
    },
    delayResult: (ms: number) => {
      resultDelay = ms;
    },
    failNextSync: () => {
      syncFailure = true;
    },
  };
}
