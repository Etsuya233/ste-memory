import {
  MemoryFieldService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldKey,
  type MemorySpace,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKey,
} from "@ste-memory/core/memory";
import type {
  MemoryFieldRepository,
  MemorySpaceRepository,
  MemoryTableRepository,
} from "@ste-memory/core/memory/adapter";
import { describe, expect, it } from "vitest";
import { migratePlotsFields } from "../src/migrate-plots-fields.ts";
import {
  SYSTEM_FIELD_PROMPTS,
  SYSTEM_TABLE_PROMPTS,
} from "../src/application/system-memory/system-memory-table-prompts.ts";
import { SystemMemoryTableInstaller } from "../src/application/system-memory/system-memory-table-definitions.ts";

class MemoryRepository
  implements MemorySpaceRepository, MemoryTableRepository, MemoryFieldRepository
{
  space: MemorySpace | undefined;
  tables: MemoryTable[] = [];
  fields: MemoryField[] = [];

  create(value: MemorySpace): Promise<void>;
  create(value: MemoryTable): Promise<void>;
  create(value: MemoryField): Promise<void>;
  async create(value: MemorySpace | MemoryTable | MemoryField): Promise<void> {
    if ("tableId" in value) this.fields.push(value);
    else if ("memorySpaceId" in value) this.tables.push(value);
    else this.space = value;
  }

  delete(id: MemorySpaceId): Promise<boolean>;
  delete(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<boolean>;
  delete(memorySpaceId: MemorySpaceId, tableId: MemoryTableId, id: MemoryFieldId): Promise<boolean>;
  async delete(): Promise<boolean> {
    return false;
  }

  find(id: MemorySpaceId): Promise<MemorySpace | undefined>;
  find(memorySpaceId: MemorySpaceId, id: MemoryTableId): Promise<MemoryTable | undefined>;
  find(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    id: MemoryFieldId,
  ): Promise<MemoryField | undefined>;
  async find(memorySpaceId: MemorySpaceId, tableId?: MemoryTableId, fieldId?: MemoryFieldId) {
    if (fieldId) {
      return this.fields.find(
        (field) =>
          field.memorySpaceId === memorySpaceId &&
          field.tableId === tableId &&
          field.id === fieldId,
      );
    }
    if (tableId) {
      return this.tables.find(
        (table) => table.memorySpaceId === memorySpaceId && table.id === tableId,
      );
    }
    return this.space?.id === memorySpaceId ? this.space : undefined;
  }

  findByKey(memorySpaceId: MemorySpaceId, key: MemoryTableKey): Promise<MemoryTable | undefined>;
  findByKey(
    memorySpaceId: MemorySpaceId,
    tableId: MemoryTableId,
    key: MemoryFieldKey,
  ): Promise<MemoryField | undefined>;
  async findByKey(
    memorySpaceId: MemorySpaceId,
    tableIdOrKey: MemoryTableId | MemoryTableKey,
    fieldKey?: MemoryFieldKey,
  ) {
    if (fieldKey !== undefined) {
      return this.fields.find(
        (field) =>
          field.memorySpaceId === memorySpaceId &&
          field.tableId === tableIdOrKey &&
          field.key === fieldKey,
      );
    }
    return this.tables.find(
      (table) => table.memorySpaceId === memorySpaceId && table.key === tableIdOrKey,
    );
  }

  list(): Promise<MemorySpace[]>;
  list(memorySpaceId: MemorySpaceId): Promise<MemoryTable[]>;
  list(memorySpaceId: MemorySpaceId, tableId: MemoryTableId): Promise<MemoryField[]>;
  async list(memorySpaceId?: MemorySpaceId, tableId?: MemoryTableId) {
    if (tableId) {
      return this.fields.filter(
        (field) => field.memorySpaceId === memorySpaceId && field.tableId === tableId,
      );
    }
    if (memorySpaceId) {
      return this.tables.filter((table) => table.memorySpaceId === memorySpaceId);
    }
    return this.space ? [this.space] : [];
  }

  async rename(): Promise<MemorySpace | undefined> {
    return undefined;
  }

  update(value: MemoryTable): Promise<boolean>;
  update(value: MemoryField): Promise<boolean>;
  async update(value: MemoryTable | MemoryField): Promise<boolean> {
    const collection = "tableId" in value ? this.fields : this.tables;
    const index = collection.findIndex((item) => item.id === value.id);
    if (index < 0) return false;
    collection[index] = value as never;
    return true;
  }
}

const spaceId = "space-1" as MemorySpaceId;
const now = "2026-07-28T00:00:00.000Z";

interface Fixture {
  readonly repository: MemoryRepository;
  readonly spaces: MemorySpaceService;
  readonly tables: MemoryTableService;
  readonly fields: MemoryFieldService;
}

function createFixture(): Fixture {
  const repository = new MemoryRepository();
  return {
    repository,
    spaces: new MemorySpaceService(
      repository,
      () => spaceId,
      () => now,
    ),
    tables: new MemoryTableService(
      repository,
      repository,
      (() => {
        let tableId = 0;
        return () => `table-${++tableId}` as MemoryTableId;
      })(),
      () => now,
    ),
    fields: new MemoryFieldService(
      repository,
      repository,
      (() => {
        let fieldId = 0;
        return () => `field-${++fieldId}` as MemoryFieldId;
      })(),
      () => now,
    ),
  };
}

/** 按旧模板（无 start_time / end_time）安装一个包含 plots 表的记忆空间，返回 plots 表 id。 */
async function installOldPlotsSchema(fixture: Fixture): Promise<MemoryTableId> {
  await fixture.spaces.create("会话");
  const characters = (await fixture.tables.create(spaceId, {
    key: "characters",
    kind: "system",
    name: "人物",
    description: "",
    prompt: SYSTEM_TABLE_PROMPTS.characters,
  }))!;
  const plots = (await fixture.tables.create(spaceId, {
    key: "plots",
    kind: "system",
    name: "剧情",
    description: "",
    prompt: SYSTEM_TABLE_PROMPTS.plots,
  }))!;
  const fields: readonly (readonly [
    key: string,
    name: string,
    type: "short_text" | "long_text" | "multi_reference" | "single_select",
    prompt: string,
    options: readonly string[],
    referenceTableId: MemoryTableId | null,
  ])[] = [
    ["name", "名称", "short_text", "", [], null],
    ["details", "详情", "long_text", "", [], null],
    [
      "related_characters",
      "相关人物",
      "multi_reference",
      SYSTEM_FIELD_PROMPTS.relatedCharacters,
      [],
      characters.id,
    ],
    [
      "related_locations",
      "相关地点",
      "multi_reference",
      SYSTEM_FIELD_PROMPTS.relatedLocations,
      [],
      characters.id,
    ],
    [
      "status",
      "状态",
      "single_select",
      SYSTEM_FIELD_PROMPTS.plotStatus,
      ["进行中", "暂停", "已解决", "已放弃"],
      null,
    ],
    ["notes", "备注", "long_text", "", [], null],
  ];
  for (const [position, [key, name, type, prompt, options, referenceTableId]] of fields.entries()) {
    await fixture.fields.create(spaceId, plots.id, {
      key,
      name,
      type,
      required: key === "name",
      prompt,
      enabled: true,
      position,
      options,
      referenceTableId,
    });
  }
  return plots.id;
}

function plotsFields(repository: MemoryRepository, plotsTableId: MemoryTableId): MemoryField[] {
  return repository.fields
    .filter((field) => field.tableId === plotsTableId)
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
}

async function runMigration(fixture: Fixture) {
  return migratePlotsFields(fixture.spaces, fixture.tables, fixture.fields, () => {});
}

function fieldShape(field: MemoryField): readonly (string | boolean)[] {
  return [field.key, field.name, field.type, field.required];
}

describe("plots fields migration", () => {
  it("adds start_time and end_time after status and renumbers trailing fields", async () => {
    const fixture = createFixture();
    const plotsTableId = await installOldPlotsSchema(fixture);

    const result = await runMigration(fixture);

    expect(result).toEqual({
      spacesChecked: 1,
      spacesAlreadyMigrated: 0,
      spacesWithoutPlotsTable: 0,
      fieldsAdded: 2,
      fieldsRenumbered: 1,
    });
    expect(plotsFields(fixture.repository, plotsTableId).map(fieldShape)).toEqual([
      ["name", "名称", "short_text", true],
      ["details", "详情", "long_text", false],
      ["related_characters", "相关人物", "multi_reference", false],
      ["related_locations", "相关地点", "multi_reference", false],
      ["status", "状态", "single_select", false],
      ["start_time", "开始时间", "date", false],
      ["end_time", "结束时间", "date", false],
      ["notes", "备注", "long_text", false],
    ]);
    const notes = plotsFields(fixture.repository, plotsTableId).find(
      (field) => field.key === "notes",
    )!;
    expect(notes.position).toBe(7);
    expect(notes.id).toBe("field-6");
  });

  it("is idempotent: a second run changes nothing", async () => {
    const fixture = createFixture();
    const plotsTableId = await installOldPlotsSchema(fixture);
    await runMigration(fixture);

    const result = await runMigration(fixture);

    expect(result).toEqual({
      spacesChecked: 1,
      spacesAlreadyMigrated: 1,
      spacesWithoutPlotsTable: 0,
      fieldsAdded: 0,
      fieldsRenumbered: 0,
    });
    expect(plotsFields(fixture.repository, plotsTableId).map(fieldShape)).toEqual([
      ["name", "名称", "short_text", true],
      ["details", "详情", "long_text", false],
      ["related_characters", "相关人物", "multi_reference", false],
      ["related_locations", "相关地点", "multi_reference", false],
      ["status", "状态", "single_select", false],
      ["start_time", "开始时间", "date", false],
      ["end_time", "结束时间", "date", false],
      ["notes", "备注", "long_text", false],
    ]);
  });

  it("produces the same plots schema as the installer for a fresh space", async () => {
    const migrated = createFixture();
    await installOldPlotsSchema(migrated);
    await runMigration(migrated);

    const installed = createFixture();
    await installed.spaces.create("会话");
    await new SystemMemoryTableInstaller(installed.tables, installed.fields).install(spaceId);

    const migratedPlots = migrated.repository.tables.find((table) => table.key === "plots")!;
    const installedPlots = installed.repository.tables.find((table) => table.key === "plots")!;
    const shape = (fields: MemoryField[]) =>
      fields.map((field) => [
        field.key,
        field.name,
        field.type,
        field.required,
        field.prompt,
        field.position,
      ]);
    expect(
      shape(
        migrated.repository.fields
          .filter((field) => field.tableId === migratedPlots.id)
          .sort((left, right) => left.position - right.position),
      ),
    ).toEqual(
      shape(
        installed.repository.fields
          .filter((field) => field.tableId === installedPlots.id)
          .sort((left, right) => left.position - right.position),
      ),
    );
  });

  it("keeps user-added fields in their relative order", async () => {
    const fixture = createFixture();
    const plotsTableId = await installOldPlotsSchema(fixture);
    // 用户在 status 与 notes 之间插入了一个自定义字段
    const notes = fixture.repository.fields.find(
      (field) => field.tableId === plotsTableId && field.key === "notes",
    )!;
    await fixture.fields.update(spaceId, plotsTableId, notes.id, { position: 6 });
    await fixture.fields.create(spaceId, plotsTableId, {
      key: "custom_note",
      name: "自定义备注",
      type: "long_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 5,
    });

    const result = await runMigration(fixture);

    expect(result.fieldsAdded).toBe(2);
    expect(plotsFields(fixture.repository, plotsTableId).map((field) => field.key)).toEqual([
      "name",
      "details",
      "related_characters",
      "related_locations",
      "status",
      "start_time",
      "end_time",
      "custom_note",
      "notes",
    ]);
    expect(plotsFields(fixture.repository, plotsTableId).map((field) => field.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("adds only the missing field when one of the two already exists", async () => {
    const fixture = createFixture();
    const plotsTableId = await installOldPlotsSchema(fixture);
    // 模拟已部分迁移的空间：notes 已后移，start_time 已存在
    const notes = fixture.repository.fields.find(
      (field) => field.tableId === plotsTableId && field.key === "notes",
    )!;
    await fixture.fields.update(spaceId, plotsTableId, notes.id, { position: 6 });
    await fixture.fields.create(spaceId, plotsTableId, {
      key: "start_time",
      name: "开始时间",
      type: "date",
      required: false,
      prompt: "",
      enabled: true,
      position: 5,
    });

    const result = await runMigration(fixture);

    expect(result).toEqual({
      spacesChecked: 1,
      spacesAlreadyMigrated: 0,
      spacesWithoutPlotsTable: 0,
      fieldsAdded: 1,
      fieldsRenumbered: 1,
    });
    expect(plotsFields(fixture.repository, plotsTableId).map((field) => field.key)).toEqual([
      "name",
      "details",
      "related_characters",
      "related_locations",
      "status",
      "start_time",
      "end_time",
      "notes",
    ]);
  });

  it("skips spaces without a plots table", async () => {
    const fixture = createFixture();
    await fixture.spaces.create("会话");

    const result = await runMigration(fixture);

    expect(result).toEqual({
      spacesChecked: 1,
      spacesAlreadyMigrated: 0,
      spacesWithoutPlotsTable: 1,
      fieldsAdded: 0,
      fieldsRenumbered: 0,
    });
    expect(fixture.repository.fields).toHaveLength(0);
  });
});
