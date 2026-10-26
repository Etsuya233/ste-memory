import {
  effectiveVectorIndexGroups,
  type MemoryField,
  type MemoryFieldId,
  type VectorIndexConfiguration,
  type VectorIndexGroup,
} from "../memory/index.ts";
import type { TablePresetTable, TablePresetVectorIndex } from "./preset-model.ts";

export function capturePresetVectorIndex(
  configuration: VectorIndexConfiguration | undefined,
  fields: readonly MemoryField[],
): TablePresetVectorIndex | undefined {
  if (!configuration) return undefined;
  const fieldKeyById = new Map(fields.map((field) => [field.id, field.key]));
  const groups = effectiveVectorIndexGroups(configuration, fields).map((group) => ({
    key: group.key,
    name: group.name,
    fieldKeys: group.fieldIds.map((fieldId) => {
      const field = fields.find((candidate) => candidate.id === fieldId);
      if (!field || !field.enabled)
        throw new Error(`向量分组「${group.name}」引用了不存在或停用的字段：${fieldId}`);
      return fieldKeyById.get(fieldId)!;
    }),
  }));
  if (configuration.enabled && groups.length === 0)
    throw new Error("启用索引的表没有可保存的向量分组");
  return { enabled: configuration.enabled, updateMode: configuration.updateMode, groups };
}

export function importPresetVectorIndexGroups(
  presetTable: Pick<TablePresetTable, "vectorIndex">,
  fields: readonly Pick<MemoryField, "id" | "key" | "enabled">[],
  createGroupId: () => string,
): readonly VectorIndexGroup[] {
  const config = presetTable.vectorIndex;
  if (!config) throw new Error("所选预设表尚无向量配置");
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const problems: string[] = [];
  for (const group of config.groups) {
    for (const fieldKey of group.fieldKeys) {
      const field = byKey.get(fieldKey as MemoryField["key"]);
      if (!field) problems.push(`字段「${fieldKey}」不存在`);
      else if (!field.enabled) problems.push(`字段「${fieldKey}」已停用`);
    }
  }
  if (problems.length > 0) throw new Error(`预设向量配置无法导入：${problems.join("；")}`);
  return config.groups.map((group) => ({
    id: createGroupId(),
    key: group.key,
    name: group.name,
    fieldIds: group.fieldKeys.map(
      (key) => byKey.get(key as MemoryField["key"])!.id as MemoryFieldId,
    ),
  }));
}
