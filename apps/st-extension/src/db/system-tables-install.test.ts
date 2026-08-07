import { SystemMemoryTableInstaller } from "@ste-memory/memory-host-shared";
import { describe, expect, it } from "vitest";
import { createServices, createTestDatabase } from "./test-support.ts";

describe("system memory table initialization (Dexie)", () => {
  it("installs the eight system tables with fields, references and display strategies", async () => {
    const { spaces, tables, fields, tableRepository, fieldRepository } =
      createServices(createTestDatabase());
    const space = await spaces.create("会话");

    await new SystemMemoryTableInstaller(tables, fields).install(space.id);

    const installed = await tableRepository.list(space.id);
    expect(installed).toHaveLength(8);
    expect(installed.map(({ key, name }) => [key, name])).toEqual([
      ["characters", "人物"],
      ["relationships", "人际关系"],
      ["locations", "地点"],
      ["items", "物品"],
      ["plots", "剧情"],
      ["foreshadowing", "伏笔"],
      ["todos", "待办"],
      ["story_state", "世界状态"],
    ]);
    expect(installed.every((table) => table.kind === "system" && table.enabled)).toBe(true);
    expect(installed.every((table) => table.prompt.length > 0)).toBe(true);

    const fieldsByTable = new Map<string, Awaited<ReturnType<typeof fieldRepository.list>>>();
    for (const table of installed) {
      fieldsByTable.set(table.key, await fieldRepository.list(space.id, table.id));
    }
    expect(fieldsByTable.get("characters")!.map(({ key, name }) => [key, name])).toEqual([
      ["name", "名称"],
      ["aliases", "别名"],
      ["role", "身份/定位"],
      ["personality", "性格特征"],
      ["appearance", "外貌特征"],
      ["background", "背景/经历"],
      ["current_status", "当前状态"],
    ]);

    const characters = installed.find((table) => table.key === "characters")!;
    const relationships = installed.find((table) => table.key === "relationships")!;
    const locations = installed.find((table) => table.key === "locations")!;
    const relationshipFields = fieldsByTable.get("relationships")!;
    // 引用字段指向本空间内的表
    expect(relationshipFields.slice(0, 2)).toMatchObject([
      { type: "single_reference", required: true, referenceTableId: characters.id },
      { type: "single_reference", required: true, referenceTableId: characters.id },
    ]);
    expect(relationships.displayStrategy).toEqual({
      type: "template",
      template: `{${relationshipFields[0]!.id}} <-> {${relationshipFields[1]!.id}}`,
    });
    expect(fieldsByTable.get("items")!.slice(2, 4)).toMatchObject([
      { type: "single_reference", referenceTableId: characters.id },
      { type: "single_reference", referenceTableId: locations.id },
    ]);
    expect(fieldsByTable.get("plots")!.slice(2, 5)).toMatchObject([
      { type: "multi_reference", referenceTableId: characters.id },
      { type: "multi_reference", referenceTableId: installed.find((t) => t.key === "locations")!.id },
      { type: "single_select", options: ["进行中", "暂停", "已解决", "已放弃"] },
    ]);
    for (const table of installed.filter((table) => table.key !== "relationships")) {
      const name = fieldsByTable.get(table.key)![0]!;
      expect(name).toMatchObject({ name: "名称", type: "short_text", required: true });
      expect(table.displayStrategy).toEqual({ type: "field", fieldId: name.id });
    }
  });

  it("keeps each space's system tables isolated (跨空间互不可见)", async () => {
    const { spaces, tables, fields, tableRepository, fieldRepository } =
      createServices(createTestDatabase());
    const spaceA = await spaces.create("会话 A");
    const spaceB = await spaces.create("会话 B");

    await new SystemMemoryTableInstaller(tables, fields).install(spaceA.id);
    await new SystemMemoryTableInstaller(tables, fields).install(spaceB.id);

    const tablesA = await tableRepository.list(spaceA.id);
    const tablesB = await tableRepository.list(spaceB.id);
    expect(tablesA).toHaveLength(8);
    expect(tablesB).toHaveLength(8);
    // 同 Key 不同 id：两个空间的系统表互不串扰（顺序按 id 兜底排序，不比较次序）
    expect(new Set(tablesA.map((table) => table.key))).toEqual(
      new Set(tablesB.map((table) => table.key)),
    );
    // 同 Key 不同 id：两个空间的系统表互不串扰
    expect(new Set(tablesA.map((table) => table.id))).toHaveLength(8);
    expect(tablesA.some((tableA) => tablesB.some((tableB) => tableA.id === tableB.id))).toBe(false);
    expect(await tableRepository.find(spaceA.id, tablesB[0]!.id)).toBeUndefined();

    const tableA = tablesA.find((table) => table.key === "characters")!;
    const tableB = tablesB.find((table) => table.key === "characters")!;
    const fieldsA = await fieldRepository.list(spaceA.id, tableA.id);
    const fieldsB = await fieldRepository.list(spaceB.id, tableB.id);
    expect(fieldsA.map((field) => field.key)).toEqual(fieldsB.map((field) => field.key));
    // 引用目标不跨空间：A 的引用字段指向 A 的表（relationships 的前两个字段引用 characters）
    const relationA = tablesA.find((table) => table.key === "relationships")!;
    const relationB = tablesB.find((table) => table.key === "relationships")!;
    const relationFieldsA = await fieldRepository.list(spaceA.id, relationA.id);
    const relationFieldsB = await fieldRepository.list(spaceB.id, relationB.id);
    expect(relationFieldsA[0]).toMatchObject({ type: "single_reference" });
    expect(
      tablesA.map((table) => table.id).includes(relationFieldsA[0]!.referenceTableId!),
    ).toBe(true);
    expect(
      tablesB.map((table) => table.id).includes(relationFieldsB[0]!.referenceTableId!),
    ).toBe(true);
    expect(relationFieldsA[0]!.referenceTableId).not.toBe(
      relationFieldsB[0]!.referenceTableId,
    );
  });
});
