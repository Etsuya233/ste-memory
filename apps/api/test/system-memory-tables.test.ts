import {
  MemorySpaceService,
  MemoryFieldService,
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
const tableIds = Array.from({ length: 7 }, (_, index) => `table-${index + 1}` as MemoryTableId);
const now = "2026-07-28T00:00:00.000Z";

describe("system memory table initialization", () => {
  it("creates one editable definition for every system table in a new memory space", async () => {
    const repository = new MemoryRepository();
    const ids = [...tableIds];
    const space = await new MemorySpaceService(
      repository,
      () => spaceId,
      () => now,
    ).create("会话");
    await new SystemMemoryTableInstaller(
      new MemoryTableService(
        repository,
        repository,
        () => ids.shift()!,
        () => now,
      ),
      new MemoryFieldService(
        repository,
        repository,
        (() => {
          let fieldId = 0;
          return () => `field-${++fieldId}` as MemoryFieldId;
        })(),
        () => now,
      ),
    ).install(space.id);

    expect(repository.tables).toHaveLength(7);
    expect(repository.tables.map(({ key, name }) => [key, name])).toEqual([
      ["characters", "人物"],
      ["relationships", "人际关系"],
      ["locations", "地点"],
      ["items", "物品"],
      ["plots", "剧情"],
      ["foreshadowing", "伏笔"],
      ["todos", "待办"],
    ]);
    expect(repository.tables.every((table) => table.kind === "system" && table.enabled)).toBe(true);
    expect(repository.tables.every((table) => table.prompt.length > 0)).toBe(true);
  });

  it("uses the issue field lists, references and display strategies", async () => {
    const repository = new MemoryRepository();
    const ids = [...tableIds];
    const space = await new MemorySpaceService(
      repository,
      () => spaceId,
      () => now,
    ).create("会话");
    await new SystemMemoryTableInstaller(
      new MemoryTableService(
        repository,
        repository,
        () => ids.shift()!,
        () => now,
      ),
      new MemoryFieldService(
        repository,
        repository,
        (() => {
          let fieldId = 0;
          return () => `field-${++fieldId}` as MemoryFieldId;
        })(),
        () => now,
      ),
    ).install(space.id);

    const fieldsByTable = new Map<string, MemoryField[]>(
      repository.tables.map((table) => [
        table.key,
        repository.fields.filter((field) => field.tableId === table.id),
      ]),
    );
    expect([...fieldsByTable.get("characters")!].map(({ key, name }) => [key, name])).toEqual([
      ["name", "名称"],
      ["aliases", "别名"],
      ["role", "身份/定位"],
      ["personality", "性格特征"],
      ["appearance", "外貌特征"],
      ["background", "背景/经历"],
      ["current_status", "当前状态"],
      ["notes", "备注"],
    ]);
    expect([...fieldsByTable.get("relationships")!].map(({ key, name }) => [key, name])).toEqual([
      ["character_a", "人物 A"],
      ["character_b", "人物 B"],
      ["description", "关系描述"],
      ["current_status", "当前状态"],
      ["key_facts", "关键事实"],
      ["notes", "备注"],
    ]);
    expect([...fieldsByTable.get("locations")!].map(({ key, name }) => [key, name])).toEqual([
      ["name", "名称"],
      ["type", "地点类型"],
      ["details", "详细地点文本"],
      ["current_status", "当前状态"],
      ["related_characters", "相关人物"],
      ["related_items", "相关物品"],
      ["notes", "备注"],
    ]);
    expect([...fieldsByTable.get("items")!].map(({ key, name }) => [key, name])).toEqual([
      ["name", "名称"],
      ["type", "物品类型"],
      ["owner", "持有者/所属人物"],
      ["current_location", "当前位置"],
      ["current_status", "状态"],
      ["key_attributes", "关键属性"],
      ["notes", "备注"],
    ]);
    expect([...fieldsByTable.get("plots")!].map(({ key, name }) => [key, name])).toEqual([
      ["name", "名称"],
      ["details", "详情"],
      ["related_characters", "相关人物"],
      ["related_locations", "相关地点"],
      ["status", "状态"],
      ["start_time", "开始时间"],
      ["end_time", "结束时间"],
      ["notes", "备注"],
    ]);
    expect([...fieldsByTable.get("foreshadowing")!].map(({ key, name }) => [key, name])).toEqual([
      ["name", "名称"],
      ["details", "详情"],
      ["related_characters", "相关人物"],
      ["related_locations", "相关地点"],
      ["status", "状态"],
      ["resolution_plan", "计划回收信息"],
      ["notes", "备注"],
    ]);
    expect([...fieldsByTable.get("todos")!].map(({ key, name }) => [key, name])).toEqual([
      ["name", "名称"],
      ["details", "详情"],
      ["related_characters", "相关人物"],
      ["related_locations", "相关地点"],
      ["priority", "优先级"],
      ["status", "状态"],
      ["due_date", "截止日期"],
      ["notes", "备注"],
    ]);

    const characters = repository.tables.find((table) => table.key === "characters")!;
    const relationships = repository.tables.find((table) => table.key === "relationships")!;
    const locations = repository.tables.find((table) => table.key === "locations")!;
    const items = repository.tables.find((table) => table.key === "items")!;
    const relationshipFields = fieldsByTable.get("relationships")!;
    expect(relationshipFields.slice(0, 2)).toMatchObject([
      { type: "single_reference", required: true, referenceTableId: characters.id },
      { type: "single_reference", required: true, referenceTableId: characters.id },
    ]);
    expect(relationships.displayStrategy).toEqual({
      type: "template",
      template: `{${relationshipFields[0]!.id}} <-> {${relationshipFields[1]!.id}}`,
    });
    expect(fieldsByTable.get("locations")!.slice(4, 6)).toMatchObject([
      { type: "multi_reference", referenceTableId: characters.id },
      { type: "multi_reference", referenceTableId: items.id },
    ]);
    expect(fieldsByTable.get("items")!.slice(2, 4)).toMatchObject([
      { type: "single_reference", referenceTableId: characters.id },
      { type: "single_reference", referenceTableId: locations.id },
    ]);
    expect(fieldsByTable.get("plots")!.slice(2, 5)).toMatchObject([
      { type: "multi_reference", referenceTableId: characters.id },
      { type: "multi_reference", referenceTableId: locations.id },
      { type: "single_select", options: ["进行中", "暂停", "已解决", "已放弃"] },
    ]);
    expect(fieldsByTable.get("foreshadowing")![4]).toMatchObject({
      type: "single_select",
      options: ["埋设中", "已触发", "已回收", "已放弃"],
    });
    expect(fieldsByTable.get("todos")!.slice(4, 7)).toMatchObject([
      { type: "single_select", options: ["高", "中", "低"] },
      { type: "single_select", options: ["待处理", "进行中", "已完成", "已放弃"] },
      { type: "date" },
    ]);
    for (const table of repository.tables.filter((table) => table.key !== "relationships")) {
      const name = fieldsByTable.get(table.key)![0]!;
      expect(name).toMatchObject({ name: "名称", type: "short_text", required: true });
      expect(table.displayStrategy).toEqual({ type: "field", fieldId: name.id });
    }
  });
});
