import { describe, expect, it } from "vitest";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import { normalizeBackupData } from "../backup/backup-codec.ts";
import type { MemoryFieldId, MemorySpaceId, MemoryTableId, MemoryTable } from "../memory/index.ts";
import { remapVectorIndexConfiguration } from "../memory/index.ts";
import { instantiateTablePreset } from "./preset-instantiation.ts";
import { STORY_MEMORY_PRESET } from "./story-memory-preset.ts";
import {
  buildPresetUpdate,
  previewPresetUpdate,
  presetUpdateChanges,
} from "./preset-space-update.ts";
import type { ResolvedTablePreset } from "./preset-model.ts";

const stamp = "2026-10-26T00:00:00Z";
function fixture() {
  let counter = 0;
  const ids = {
    table: () => `table-${++counter}` as MemoryTableId,
    field: () => `field-${++counter}` as MemoryFieldId,
    group: () => `group-${++counter}`,
  };
  const preset: ResolvedTablePreset = {
    ...STORY_MEMORY_PRESET,
    tables: [structuredClone(STORY_MEMORY_PRESET.tables[0]!)],
  };
  const spaceId = "space" as MemorySpaceId;
  const structure = instantiateTablePreset(preset, spaceId, ids, stamp);
  const unit: MemorySpaceBackup = {
    space: {
      id: spaceId,
      name: "测试空间",
      prompt: preset.prompt,
      initializationSource: { presetId: preset.id, presetName: preset.name, appliedAt: stamp },
      createdAt: stamp,
      updatedAt: stamp,
    },
    ...structure,
    records: [],
    history: [],
    evidence: [],
    floorLedger: [{ floor: 1, status: "processed", updatedAt: stamp }],
  };
  return { unit, preset, ids };
}

describe("从表格预设选择性更新空间", () => {
  it("按 Key 匹配不同名称的 entry；保留已有分组、表和字段身份及未选属性", () => {
    const { unit, preset, ids } = fixture();
    const first = preset.tables[0]!;
    const updated = {
      ...preset,
      tables: [
        {
          ...first,
          name: "角色",
          prompt: "新填写规则",
          vectorIndex: {
            ...first.vectorIndex!,
            groups: first.vectorIndex!.groups.map((group, index) =>
              index === 0 ? { ...group, name: "改名后的人物信息", fieldKeys: ["name"] } : group,
            ),
          },
        },
      ],
    };
    const plan = previewPresetUpdate(unit, updated);
    const selected = presetUpdateChanges(plan.nodes)
      .filter((change) => change.entity === "group" || change.property === "prompt")
      .map((change) => change.id);
    const result = buildPresetUpdate(unit, plan, selected, ids, "new-time");
    expect(result.tables[0]!.id).toBe(unit.tables[0]!.id);
    expect(result.tables[0]!.name).toBe(unit.tables[0]!.name);
    expect(result.tables[0]!.prompt).toBe("新填写规则");
    expect(result.tables[0]!.vectorIndex!.presetGroups![0]).toMatchObject({
      id: unit.tables[0]!.vectorIndex!.presetGroups![0]!.id,
      key: first.vectorIndex!.groups[0]!.key,
      name: "改名后的人物信息",
      fieldIds: [unit.fields[0]!.id],
    });
    expect(result.fields).toEqual(unit.fields);
    expect(result.floorLedger).toEqual(unit.floorLedger);
    expect(result.space.initializationSource).toEqual(unit.space.initializationSource);
  });

  it("字段同 Key 类型不同只提示，选名称更新仍保留当前类型", () => {
    const { unit, preset, ids } = fixture();
    const table = preset.tables[0]!;
    const updated = {
      ...preset,
      tables: [
        {
          ...table,
          fields: table.fields.map((field) =>
            field.key === "background"
              ? { ...field, type: "short_text" as const, name: "人物经历" }
              : field,
          ),
        },
      ],
    };
    const plan = previewPresetUpdate(unit, updated);
    const choice = presetUpdateChanges(plan.nodes).find(
      (change) => change.entity === "field" && change.property === "name",
    )!;
    const result = buildPresetUpdate(unit, plan, [choice.id], ids, stamp);
    expect(result.fields.find((field) => field.key === "background")).toMatchObject({
      type: "long_text",
      name: "人物经历",
    });
  });

  it("阻止删除或停用仍被显示策略、向量分组依赖的字段", () => {
    const { unit, preset, ids } = fixture();
    const table = preset.tables[0]!;
    const next = {
      ...preset,
      tables: [
        {
          ...table,
          vectorIndex: undefined,
          fields: table.fields.filter((field) => field.key !== "personality"),
        },
      ],
    };
    const plan = previewPresetUpdate(unit, next);
    const removal = presetUpdateChanges(plan.nodes).find((change) => change.action === "delete")!;
    expect(() => buildPresetUpdate(unit, plan, [removal.id], ids, stamp)).toThrow("不存在或停用");
    const disabled = {
      ...preset,
      tables: [
        {
          ...table,
          displayStrategy: null,
          vectorIndex: undefined,
          fields: table.fields.map((field) =>
            field.key === "name" ? { ...field, enabled: false } : field,
          ),
        },
      ],
    };
    const other = previewPresetUpdate(unit, disabled);
    const toggle = presetUpdateChanges(other.nodes).find(
      (change) => change.entity === "field" && change.property === "enabled",
    )!;
    expect(() => buildPresetUpdate(unit, other, [toggle.id], ids, stamp)).toThrow("显示策略依赖");
  });

  it("字段删除清理当前值、历史和独占证据，保留其他字段、共享证据及记录身份", () => {
    const { unit, preset, ids } = fixture();
    const removed = unit.fields.find((field) => field.key === "background")!;
    const kept = unit.fields[0]!;
    const shared = {
      evidence_id: "shared",
      storage_mode: "snapshot",
      source_type: "test",
      source_id: "1",
      content: "正文",
      extraProps: {},
    };
    const exclusive = { ...shared, evidence_id: "exclusive" };
    const record = {
      id: "record",
      memorySpaceId: unit.space.id,
      tableId: unit.tables[0]!.id,
      payload: { [removed.id]: "旧经历", [kept.id]: "名字" },
      fieldEvidence: { [removed.id]: [exclusive, shared], [kept.id]: [shared] },
      displayText: "名字",
      source: { type: "manual" },
      revisionId: "revision",
      revisionSource: "user",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const populated = {
      ...unit,
      records: [record],
      history: [
        {
          ...record,
          id: "history",
          recordId: "record",
          previousRevisionId: "old",
          previousRevisionSource: "user",
          archivedAt: stamp,
        },
      ],
      evidence: [shared, exclusive],
    } as unknown as MemorySpaceBackup;
    const table = preset.tables[0]!;
    const target = {
      ...preset,
      tables: [
        {
          ...table,
          vectorIndex: {
            ...table.vectorIndex!,
            groups: table.vectorIndex!.groups.filter(
              (group) => !group.fieldKeys.includes("background"),
            ),
          },
          fields: table.fields.filter((field) => field.key !== "background"),
        },
      ],
    };
    const plan = previewPresetUpdate(populated, target);
    const selected = presetUpdateChanges(plan.nodes)
      .filter((change) => change.action === "delete")
      .map((change) => change.id);
    const result = buildPresetUpdate(populated, plan, selected, ids, stamp);
    expect(result.records[0]).toMatchObject({
      id: "record",
      payload: { [kept.id]: "名字" },
      revisionId: "revision",
    });
    expect(result.records[0]!.payload).not.toHaveProperty(removed.id);
    expect(result.history[0]!.payload).not.toHaveProperty(removed.id);
    expect(result.evidence.map((item) => item.evidence_id)).toEqual(["shared"]);
  });

  it("新增表字段和分组有新身份，未选删除的空间独有表仍保留", () => {
    const { unit, preset, ids } = fixture();
    const extra = {
      ...unit.tables[0]!,
      id: "local" as MemoryTableId,
      key: "local" as MemoryTable["key"],
      vectorIndex: undefined,
      displayStrategy: null,
    };
    const source = { ...unit, tables: [...unit.tables, extra] };
    const added = { ...preset.tables[0]!, key: "new_table", name: "新人物" };
    const plan = previewPresetUpdate(source, { ...preset, tables: [...preset.tables, added] });
    const create = presetUpdateChanges(plan.nodes).find((change) => change.action === "create")!;
    const result = buildPresetUpdate(source, plan, [create.id], ids, stamp);
    expect(result.tables.some((table) => table.id === "local")).toBe(true);
    const next = result.tables.find((table) => table.key === "new_table")!;
    expect(next.id).not.toBe(unit.tables[0]!.id);
    expect(next.vectorIndex!.presetGroups![0]!.key).toBe(
      unit.tables[0]!.vectorIndex!.presetGroups![0]!.key,
    );
    expect(next.vectorIndex!.presetGroups![0]!.id).not.toBe(
      unit.tables[0]!.vectorIndex!.presetGroups![0]!.id,
    );
  });

  it("拒绝失效预览与同表重复分组 Key，允许相同名称的不同 Key", () => {
    const { unit, preset, ids } = fixture();
    const table = preset.tables[0]!;
    const next = { ...preset, prompt: "更新" };
    const plan = previewPresetUpdate(unit, next);
    const selected = presetUpdateChanges(plan.nodes).map((change) => change.id);
    expect(() =>
      buildPresetUpdate(
        { ...unit, space: { ...unit.space, updatedAt: "changed" } },
        plan,
        selected,
        ids,
        stamp,
      ),
    ).toThrow("重新比较");
    const groups = table.vectorIndex!.groups;
    expect(() =>
      previewPresetUpdate(unit, {
        ...preset,
        tables: [
          {
            ...table,
            vectorIndex: {
              ...table.vectorIndex!,
              groups: [groups[0]!, { ...groups[1]!, key: groups[0]!.key }],
            },
          },
        ],
      }),
    ).toThrow("Key 重复");
    expect(() =>
      previewPresetUpdate(unit, {
        ...preset,
        tables: [
          {
            ...table,
            vectorIndex: {
              ...table.vectorIndex!,
              groups: groups.map((group) => ({ ...group, name: "同名" })),
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("旧空间分组以原 ID 补 Key，克隆来源 Key 不受实例化新 ID 影响", () => {
    const { unit } = fixture();
    const legacy = structuredClone(unit);
    for (const group of legacy.tables[0]!.vectorIndex!.presetGroups!)
      delete (group as { key?: string }).key;
    const updated = normalizeBackupData({ spaces: [legacy] }).spaces[0]!;
    expect(updated.tables[0]!.vectorIndex!.presetGroups![0]!.key).toBe(
      unit.tables[0]!.vectorIndex!.presetGroups![0]!.id,
    );
    expect(updated.tables[0]!.vectorIndex!.presetGroups![0]!.id).toBe(
      unit.tables[0]!.vectorIndex!.presetGroups![0]!.id,
    );
    const config = unit.tables[0]!.vectorIndex!;
    const cloned = remapVectorIndexConfiguration(
      config,
      new Map(unit.fields.map((field) => [field.id, field.id])),
      () => "new-group-id",
    )!;
    expect(cloned.presetGroups![0]!.key).toBe(config.presetGroups![0]!.key);
    expect(cloned.presetGroups![0]!.id).toBe("new-group-id");
  });
});
