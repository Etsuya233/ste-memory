import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import { validateBackupData } from "../backup/backup-codec.ts";
import {
  effectiveVectorIndexGroups,
  memoryTableDisplayFieldIds,
  validateVectorIndexConfiguration,
  type MemoryField,
  type MemoryTable,
  type VectorIndexConfiguration,
} from "../memory/index.ts";
import { instantiateTablePreset, type PresetInstantiationIds } from "./preset-instantiation.ts";
import type { ResolvedTablePreset, TablePresetDisplayStrategy } from "./preset-model.ts";

export interface PresetUpdateChange {
  readonly id: string;
  readonly entity: "space" | "table" | "field" | "vector" | "group";
  readonly action: "create" | "update" | "delete";
  readonly tableKey?: string;
  readonly fieldKey?: string;
  readonly groupKey?: string;
  readonly property?: "prompt" | "name" | "enabled" | "displayStrategy" | "updateMode";
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface PresetUpdateNode {
  readonly id: string;
  readonly label: string;
  readonly change?: PresetUpdateChange;
  readonly note?: string;
  readonly children: readonly PresetUpdateNode[];
}

export interface PresetUpdatePlan {
  readonly spaceId: MemorySpaceBackup["space"]["id"];
  readonly spaceName: string;
  readonly baseline: string;
  readonly preset: ResolvedTablePreset;
  readonly nodes: readonly PresetUpdateNode[];
}

export interface PresetUpdateOutcome {
  readonly issues: readonly string[];
}

export interface PresetSpaceUpdateService {
  preview(
    spaceId: PresetUpdatePlan["spaceId"],
    preset: ResolvedTablePreset,
    chatIdentity: string,
  ): Promise<PresetUpdatePlan>;
  apply(
    plan: PresetUpdatePlan,
    selectedIds: readonly string[],
    chatIdentity: string,
  ): Promise<PresetUpdateOutcome>;
  retrySave(
    spaceId: PresetUpdatePlan["spaceId"],
    chatIdentity: string,
  ): Promise<PresetUpdateOutcome>;
}

/** A preview is invalidated by structural edits or record changes, including deletions. */
export function presetUpdateFingerprint(unit: MemorySpaceBackup): string {
  return JSON.stringify([
    unit.space,
    unit.tables,
    unit.fields,
    unit.records,
    unit.history,
    unit.evidence,
  ]);
}

const propertyLabels = {
  prompt: "Prompt",
  name: "名称",
  enabled: "开关状态",
  displayStrategy: "显示策略",
  updateMode: "更新方式",
} as const;

function displayStrategy(
  table: MemoryTable,
  fields: readonly MemoryField[],
): TablePresetDisplayStrategy | null {
  const strategy = table.displayStrategy;
  if (!strategy) return null;
  const byId = new Map(fields.map((field) => [field.id, field.key]));
  if (strategy.type === "field") {
    const key = byId.get(strategy.fieldId);
    if (!key) throw new Error(`表「${table.key}」的显示字段不存在：${strategy.fieldId}`);
    return { type: "field", fieldKey: key };
  }
  return {
    type: "template",
    template: strategy.template.replace(/\{([^{}]+)\}/g, (_, id: MemoryField["id"]) => {
      const key = byId.get(id);
      if (!key) throw new Error(`表「${table.key}」的显示模板字段不存在：${id}`);
      return `{${key}}`;
    }),
  };
}

function groupsOf(table: MemoryTable, fields: readonly MemoryField[]) {
  return effectiveVectorIndexGroups(table.vectorIndex, fields).map((group) => ({
    key: group.key,
    name: group.name,
    fieldKeys: group.fieldIds.map((id) => {
      const field = fields.find((item) => item.id === id);
      if (!field)
        throw new Error(`表「${table.key}」的向量分组「${group.key}」引用了不存在的字段：${id}`);
      return field.key;
    }),
  }));
}

export function previewPresetUpdate(
  unit: MemorySpaceBackup,
  preset: ResolvedTablePreset,
): PresetUpdatePlan {
  const nodes: PresetUpdateNode[] = [];
  const leaf = (
    label: string,
    change: Omit<PresetUpdateChange, "id">,
    note?: string,
  ): PresetUpdateNode => {
    const id = JSON.stringify([
      change.entity,
      change.tableKey,
      change.fieldKey,
      change.groupKey,
      change.property,
      change.action,
    ]);
    return { id, label, change: { ...change, id }, children: [], note };
  };
  const properties = (
    children: PresetUpdateNode[],
    entity: "space" | "table" | "field" | "vector",
    before: Partial<Record<keyof typeof propertyLabels, unknown>>,
    after: Partial<Record<keyof typeof propertyLabels, unknown>>,
    names: readonly (keyof typeof propertyLabels)[],
    tableKey?: string,
    fieldKey?: string,
  ) => {
    for (const property of names) {
      const oldValue = before[property];
      const newValue = after[property];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
        children.push(
          leaf(propertyLabels[property], {
            entity,
            action: "update",
            tableKey,
            fieldKey,
            property,
            before: oldValue,
            after: newValue,
          }),
        );
    }
  };
  properties(nodes, "space", { prompt: unit.space.prompt ?? "" }, { prompt: preset.prompt ?? "" }, [
    "prompt",
  ]);
  const targetTables = new Map(preset.tables.map((table) => [table.key, table]));
  const currentTables = new Map(unit.tables.map((table) => [String(table.key), table]));
  for (const target of preset.tables) {
    const current = currentTables.get(target.key);
    if (!current) {
      nodes.push(
        leaf(
          `${target.name} · ${target.key}`,
          { entity: "table", action: "create", tableKey: target.key, after: target },
          `创建完整表格，包含 ${target.fields.length} 个字段及预设向量配置`,
        ),
      );
      continue;
    }
    const children: PresetUpdateNode[] = [];
    const fields = unit.fields.filter((field) => field.tableId === current.id);
    properties(
      children,
      "table",
      { ...current, displayStrategy: displayStrategy(current, fields) },
      target,
      ["name", "displayStrategy", "enabled", "prompt"],
      target.key,
    );
    const fieldNodes: PresetUpdateNode[] = [];
    for (const field of target.fields) {
      const existing = fields.find((item) => item.key === field.key);
      if (!existing)
        fieldNodes.push(
          leaf(`${field.name} · ${field.key}`, {
            entity: "field",
            action: "create",
            tableKey: target.key,
            fieldKey: field.key,
            after: field,
          }),
        );
      else {
        const attributes: PresetUpdateNode[] = [];
        properties(
          attributes,
          "field",
          existing,
          field,
          ["name", "prompt", "enabled"],
          target.key,
          field.key,
        );
        const note =
          existing.type !== field.type
            ? `类型不同：${existing.type} → ${field.type}；保留当前类型`
            : undefined;
        if (attributes.length || note)
          fieldNodes.push({
            id: `field:${target.key}:${field.key}`,
            label: `${field.name} · ${field.key}`,
            children: attributes,
            note,
          });
      }
    }
    for (const field of fields) {
      if (!target.fields.some((item) => item.key === field.key))
        fieldNodes.push(
          leaf(
            `${field.name} · ${field.key}`,
            {
              entity: "field",
              action: "delete",
              tableKey: target.key,
              fieldKey: field.key,
              before: field,
            },
            "删除字段值及相关历史、证据；保留记录的其他字段",
          ),
        );
    }
    if (fieldNodes.length)
      children.push({ id: `fields:${target.key}`, label: "字段", children: fieldNodes });
    if (target.vectorIndex) {
      const vectorNodes: PresetUpdateNode[] = [];
      const config = current.vectorIndex ?? { enabled: false, updateMode: "manual" };
      properties(
        vectorNodes,
        "vector",
        config,
        target.vectorIndex,
        ["enabled", "updateMode"],
        target.key,
      );
      const oldGroups = groupsOf(current, fields);
      const seen = new Set<string>();
      for (const group of [...oldGroups, ...target.vectorIndex.groups]) {
        if (!group.key?.trim())
          throw new Error(`表「${target.key}」的向量分组缺少 Key，请先编辑分组 Key`);
      }
      for (const list of [oldGroups, target.vectorIndex.groups]) {
        seen.clear();
        for (const group of list) {
          if (seen.has(group.key))
            throw new Error(`表「${target.key}」的向量分组 Key 重复：${group.key}`);
          seen.add(group.key);
        }
      }
      for (const group of target.vectorIndex.groups) {
        const existing = oldGroups.find((item) => item.key === group.key);
        if (
          !existing ||
          existing.name !== group.name ||
          JSON.stringify(existing.fieldKeys) !== JSON.stringify(group.fieldKeys)
        )
          vectorNodes.push(
            leaf(
              `${group.name} · ${group.key}`,
              {
                entity: "group",
                action: existing ? "update" : "create",
                tableKey: target.key,
                groupKey: group.key,
                before: existing,
                after: group,
              },
              "按分组 Key 匹配；输入变化后旧索引过期",
            ),
          );
      }
      for (const group of oldGroups) {
        if (!target.vectorIndex.groups.some((item) => item.key === group.key))
          vectorNodes.push(
            leaf(
              `${group.name} · ${group.key}`,
              {
                entity: "group",
                action: "delete",
                tableKey: target.key,
                groupKey: group.key,
                before: group,
              },
              "删除该分组的索引；记忆正文保留",
            ),
          );
      }
      if (vectorNodes.length)
        children.push({
          id: `vector:${target.key}`,
          label: "向量配置",
          children: vectorNodes,
          note:
            current.vectorIndex?.source === "automatic"
              ? "选择分组变更后切换为固定预设分组；保留的自动组采用当前字段快照"
              : undefined,
        });
    }
    if (children.length)
      nodes.push({ id: `table:${target.key}`, label: `${current.name} · ${target.key}`, children });
  }
  for (const table of unit.tables) {
    if (!targetTables.has(table.key)) {
      const count = unit.records.filter((record) => record.tableId === table.id).length;
      nodes.push(
        leaf(
          `${table.name} · ${table.key}`,
          { entity: "table", action: "delete", tableKey: table.key, before: table },
          `删除整张表及 ${count} 条记录、修订历史、证据和向量`,
        ),
      );
    }
  }
  return {
    spaceId: unit.space.id,
    spaceName: unit.space.name,
    baseline: presetUpdateFingerprint(unit),
    preset: structuredClone(preset),
    nodes,
  };
}

export function presetUpdateChanges(nodes: readonly PresetUpdateNode[]): PresetUpdateChange[] {
  return nodes.flatMap((node) => [
    ...(node.change ? [node.change] : []),
    ...presetUpdateChanges(node.children),
  ]);
}

/** Compute the complete selected result before touching storage. All unselected objects keep their IDs. */
export function buildPresetUpdate(
  unit: MemorySpaceBackup,
  plan: PresetUpdatePlan,
  selectedIds: readonly string[],
  ids: PresetInstantiationIds,
  now: string,
): MemorySpaceBackup {
  if (unit.space.id !== plan.spaceId || presetUpdateFingerprint(unit) !== plan.baseline)
    throw new Error("空间内容已变化，请重新比较后执行");
  const selected = new Set(selectedIds);
  const changes = presetUpdateChanges(plan.nodes).filter((change) => selected.has(change.id));
  if (changes.length !== selected.size || changes.length === 0)
    throw new Error("请选择有效的变更项");
  const preset = plan.preset;
  let tableIndex = 0,
    fieldIndex = 0;
  const tableIds = preset.tables.map(
    (target) => unit.tables.find((table) => table.key === target.key)?.id ?? ids.table(),
  );
  const fieldIds = preset.tables.flatMap((target) =>
    target.fields.map((targetField) => {
      const table = unit.tables.find((item) => item.key === target.key);
      return (
        unit.fields.find((field) => field.tableId === table?.id && field.key === targetField.key)
          ?.id ?? ids.field()
      );
    }),
  );
  const target = instantiateTablePreset(
    preset,
    unit.space.id,
    {
      table: () => tableIds[tableIndex++]!,
      field: () => fieldIds[fieldIndex++]!,
      group: ids.group,
    },
    now,
  );
  let tables = [...unit.tables],
    fields = [...unit.fields];
  let space = unit.space;
  const deletedTableIds = new Set<string>(),
    deletedFieldIds = new Set<string>();
  for (const change of changes) {
    if (change.entity === "space") {
      space = { ...space, prompt: preset.prompt ?? "", updatedAt: now };
      continue;
    }
    if (change.entity !== "table" || change.action === "update") continue;
    if (change.action === "delete") {
      const table = tables.find((item) => item.key === change.tableKey)!;
      deletedTableIds.add(table.id);
      fields
        .filter((field) => field.tableId === table.id)
        .forEach((field) => deletedFieldIds.add(field.id));
      fields = fields.filter((field) => field.tableId !== table.id);
      tables = tables.filter((item) => item.id !== table.id);
    } else {
      const table = target.tables.find((item) => item.key === change.tableKey)!;
      tables.push({ ...table, position: Math.max(-1, ...tables.map((item) => item.position)) + 1 });
      fields.push(...target.fields.filter((field) => field.tableId === table.id));
    }
  }
  for (const change of changes) {
    if (
      change.entity === "space" ||
      change.entity === "group" ||
      (change.entity === "table" && change.action !== "update")
    )
      continue;
    const table = tables.find((item) => item.key === change.tableKey)!;
    const targetTable = target.tables.find((item) => item.key === change.tableKey)!;
    if (change.entity === "table") {
      const property = change.property as "name" | "enabled" | "prompt" | "displayStrategy";
      tables = tables.map((item) =>
        item.id === table.id
          ? { ...item, [property]: targetTable[property], updatedAt: now }
          : item,
      );
    } else if (change.entity === "field") {
      const existing = fields.find(
        (field) => field.tableId === table.id && field.key === change.fieldKey,
      );
      const desired = target.fields.find(
        (field) => field.tableId === table.id && field.key === change.fieldKey,
      );
      if (change.action === "delete") {
        deletedFieldIds.add(existing!.id);
        fields = fields.filter((field) => field.id !== existing!.id);
      } else if (change.action === "create") {
        fields.push({
          ...desired!,
          position:
            Math.max(
              -1,
              ...fields
                .filter((field) => field.tableId === table.id)
                .map((field) => field.position),
            ) + 1,
        });
      } else {
        const property = change.property as "name" | "enabled" | "prompt";
        fields = fields.map((field) =>
          field.id === existing!.id
            ? { ...field, [property]: desired![property], updatedAt: now }
            : field,
        );
      }
    } else if (change.entity === "vector") {
      const property = change.property as "enabled" | "updateMode";
      tables = tables.map((item) =>
        item.id === table.id
          ? {
              ...item,
              updatedAt: now,
              vectorIndex: {
                ...(item.vectorIndex ?? {
                  enabled: false,
                  source: "preset",
                  updateMode: "manual",
                  groups: [],
                  presetGroups: [],
                }),
                [property]: targetTable.vectorIndex![property],
              },
            }
          : item,
      );
    }
  }
  for (const table of [...tables]) {
    const groupChanges = changes.filter(
      (change) => change.entity === "group" && change.tableKey === table.key,
    );
    if (!groupChanges.length) continue;
    const config: VectorIndexConfiguration = table.vectorIndex ?? {
      enabled: false,
      source: "preset",
      updateMode: "manual",
      groups: [],
    };
    const oldFields = unit.fields.filter((field) => field.tableId === table.id);
    let groups = [...effectiveVectorIndexGroups(config, oldFields)];
    for (const change of groupChanges) {
      const existing = groups.find((group) => group.key === change.groupKey);
      if (change.action === "delete")
        groups = groups.filter((group) => group.key !== change.groupKey);
      else {
        const desired = target.tables
          .find((item) => item.key === table.key)!
          .vectorIndex!.presetGroups!.find((group) => group.key === change.groupKey)!;
        const next = { ...desired, id: existing?.id ?? desired.id };
        if (existing) groups = groups.map((group) => (group.id === existing.id ? next : group));
        else groups.push(next);
      }
    }
    tables = tables.map((item) =>
      item.id === table.id
        ? {
            ...item,
            updatedAt: now,
            vectorIndex: { ...config, source: "preset", groups: [], presetGroups: groups },
          }
        : item,
    );
  }
  for (const table of tables) {
    const tableFields = fields.filter((field) => field.tableId === table.id);
    if (table.displayStrategy) {
      for (const id of memoryTableDisplayFieldIds(table.displayStrategy)) {
        const field = tableFields.find((item) => item.id === id);
        if (
          !field?.enabled ||
          (table.displayStrategy.type === "field" && field.type !== "short_text")
        )
          throw new Error(
            `表「${table.key}」的显示策略依赖字段「${field?.key ?? id}」，请同时更新显示策略`,
          );
      }
    }
    if (table.vectorIndex) validateVectorIndexConfiguration(table.vectorIndex, tableFields);
  }
  const strip = <
    T extends MemorySpaceBackup["records"][number] | MemorySpaceBackup["history"][number],
  >(
    record: T,
  ): T => ({
    ...record,
    payload: Object.fromEntries(
      Object.entries(record.payload).filter(([id]) => !deletedFieldIds.has(id)),
    ),
    fieldEvidence: Object.fromEntries(
      Object.entries(record.fieldEvidence).filter(([id]) => !deletedFieldIds.has(id)),
    ),
  });
  const records = unit.records.filter((record) => !deletedTableIds.has(record.tableId)).map(strip);
  const history = unit.history.filter((record) => !deletedTableIds.has(record.tableId)).map(strip);
  const referencedEvidence = new Set(
    [...records, ...history].flatMap((record) =>
      Object.values(record.fieldEvidence)
        .flat()
        .map((ref) => ref.evidence_id),
    ),
  );
  const removedEvidence = new Set(
    [...unit.records, ...unit.history].flatMap((record) =>
      Object.entries(record.fieldEvidence)
        .filter(([fieldId]) => deletedTableIds.has(record.tableId) || deletedFieldIds.has(fieldId))
        .flatMap(([, refs]) => refs.map((ref) => ref.evidence_id)),
    ),
  );
  const evidence = unit.evidence.filter(
    (item) => !removedEvidence.has(item.evidence_id) || referencedEvidence.has(item.evidence_id),
  );
  const result = {
    ...unit,
    space: { ...space, updatedAt: now },
    tables,
    fields,
    records,
    history,
    evidence,
  };
  validateBackupData({ spaces: [result] });
  return result;
}
