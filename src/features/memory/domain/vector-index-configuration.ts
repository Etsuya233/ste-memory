import { DomainError } from "./domain-error.ts";
import type { MemoryField, MemoryFieldId } from "./memory-field.ts";

export interface VectorIndexGroup {
  readonly id: string;
  readonly name: string;
  readonly fieldIds: readonly MemoryFieldId[];
}

export interface VectorIndexConfiguration {
  readonly enabled: boolean;
  readonly source: "automatic" | "preset" | "custom";
  readonly updateMode: "manual" | "automatic";
  readonly groups: readonly VectorIndexGroup[];
  readonly presetGroups?: readonly VectorIndexGroup[];
}

export function effectiveVectorIndexGroups(
  configuration: VectorIndexConfiguration | undefined,
  fields: readonly MemoryField[],
): readonly VectorIndexGroup[] {
  if (!configuration) return [];
  if (configuration.source === "preset") return configuration.presetGroups ?? [];
  if (configuration.source === "custom") return configuration.groups;
  const fieldIds = fields
    .filter((field) => field.enabled)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((field) => field.id);
  return fieldIds.length === 0 ? [] : [{ id: "automatic", name: "全部启用字段", fieldIds }];
}

export function validateVectorIndexConfiguration(
  configuration: VectorIndexConfiguration,
  fields: readonly MemoryField[],
): void {
  const enabledIds = new Set(fields.filter((field) => field.enabled).map((field) => field.id));
  const groups = effectiveVectorIndexGroups(configuration, fields);
  if (configuration.enabled && groups.length === 0 && configuration.source !== "automatic") {
    throw new DomainError({
      type: "vector_index_configuration_invalid",
      humanMsg: "启用索引前需要至少一个向量分组",
    });
  }
  const ids = new Set<string>();
  for (const group of [...configuration.groups, ...(configuration.presetGroups ?? [])]) {
    if (
      !group.id.trim() ||
      !group.name.trim() ||
      group.fieldIds.length === 0 ||
      new Set(group.fieldIds).size !== group.fieldIds.length
    ) {
      throw new DomainError({
        type: "vector_index_configuration_invalid",
        humanMsg: `向量分组「${group.name}」需要名称和不重复的来源字段`,
      });
    }
  }
  for (const group of groups) {
    if (ids.has(group.id))
      throw new DomainError({
        type: "vector_index_configuration_invalid",
        humanMsg: `向量分组 ID 重复：${group.id}`,
      });
    ids.add(group.id);
    for (const fieldId of group.fieldIds) {
      if (!enabledIds.has(fieldId))
        throw new DomainError({
          type: "vector_index_configuration_invalid",
          humanMsg: `向量分组「${group.name}」引用了不存在或停用的字段：${fieldId}`,
        });
    }
  }
}

export function remapVectorIndexConfiguration(
  configuration: VectorIndexConfiguration | undefined,
  fieldIdMap: ReadonlyMap<string, MemoryFieldId>,
  createGroupId: () => string,
): VectorIndexConfiguration | undefined {
  if (!configuration) return undefined;
  const remap = (groups: readonly VectorIndexGroup[]): VectorIndexGroup[] =>
    groups.map((group) => ({
      id: createGroupId(),
      name: group.name,
      fieldIds: group.fieldIds.map((fieldId) => fieldIdMap.get(fieldId) ?? fieldId),
    }));
  return {
    ...configuration,
    groups: remap(configuration.groups),
    presetGroups:
      configuration.presetGroups === undefined ? undefined : remap(configuration.presetGroups),
  };
}
