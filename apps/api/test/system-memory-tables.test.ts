import {
  MemorySpaceService,
  MemoryFieldService,
  MemoryTableService,
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldKey,
  type MemorySpace,
  type MemorySpaceId,
  type MemorySpaceRepository,
  type MemoryFieldRepository,
  type MemoryTable,
  type MemoryTableId,
  type MemoryTableKey,
  type MemoryTableRepository,
} from "@ste-memory/core";
import { describe, expect, it } from "vitest";
import { SystemMemoryTableInstaller } from "../src/system-memory/system-memory-table-definitions.ts";

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
    expect([...fieldsByTable.get("characters")!].map((field) => field.name)).toEqual([
      "名称",
      "别名",
      "身份/定位",
      "性格特征",
      "外貌特征",
      "背景/经历",
      "当前状态",
      "备注",
    ]);
    expect([...fieldsByTable.get("relationships")!].map((field) => field.name)).toEqual([
      "人物 A",
      "人物 B",
      "关系描述",
      "当前状态",
      "关键事实",
      "备注",
    ]);
    expect([...fieldsByTable.get("locations")!].map((field) => field.name)).toEqual([
      "名称",
      "地点类型",
      "详细地点文本",
      "当前状态",
      "相关人物",
      "相关物品",
      "备注",
    ]);
    expect([...fieldsByTable.get("items")!].map((field) => field.name)).toEqual([
      "名称",
      "物品类型",
      "持有者/所属人物",
      "当前位置",
      "状态",
      "关键属性",
      "备注",
    ]);
    expect([...fieldsByTable.get("plots")!].map((field) => field.name)).toEqual([
      "名称",
      "详情",
      "相关人物",
      "相关地点",
      "状态",
      "备注",
    ]);
    expect([...fieldsByTable.get("foreshadowing")!].map((field) => field.name)).toEqual([
      "名称",
      "详情",
      "相关人物",
      "相关地点",
      "状态",
      "计划回收信息",
      "备注",
    ]);
    expect([...fieldsByTable.get("todos")!].map((field) => field.name)).toEqual([
      "名称",
      "详情",
      "相关人物",
      "相关地点",
      "优先级",
      "状态",
      "截止日期",
      "备注",
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
