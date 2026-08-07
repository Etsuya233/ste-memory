import type { MemoryFieldKey, MemoryTableId } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import { createServices, createTestDatabase } from "./test-support.ts";

async function setupFieldTest() {
  const services = createServices(createTestDatabase());
  const space = await services.spaces.create("会话");
  const table = await services.tables.create(space.id, {
    key: "clues",
    kind: "custom",
    name: "线索",
    description: "",
    prompt: "",
  });
  const tableId = table!.id;
  return { ...services, spaceId: space.id, tableId };
}

describe("Dexie memory field repository", () => {
  it("creates, finds, updates and deletes a field with full configuration", async () => {
    const { fields, fieldRepository, spaceId, tableId } = await setupFieldTest();

    const created = await fields.create(spaceId, tableId, {
      key: "location",
      name: "地点",
      type: "short_text",
      required: true,
      prompt: "线索所在的地点",
      enabled: true,
      position: 0,
      maxChars: 30,
      valuePattern: "^[^\\n]+$",
      valuePatternMessage: "地点不能换行",
    });

    expect(created).toMatchObject({
      id: "field-1",
      memorySpaceId: spaceId,
      tableId,
      key: "location",
      name: "地点",
      type: "short_text",
      required: true,
      prompt: "线索所在的地点",
      enabled: true,
      position: 0,
      options: [],
      referenceTableId: null,
      maxChars: 30,
      valuePattern: "^[^\\n]+$",
      valuePatternMessage: "地点不能换行",
    });
    expect(await fieldRepository.find(spaceId, tableId, created!.id)).toEqual(created);
    expect(await fieldRepository.list(spaceId, tableId)).toEqual([created]);

    const updated = await fields.update(spaceId, tableId, created!.id, {
      name: "所在位置",
      required: false,
      enabled: false,
      position: 3,
    });
    expect(updated?.field).toMatchObject({
      key: "location",
      name: "所在位置",
      required: false,
      enabled: false,
      position: 3,
    });
    expect(updated?.warnings).toEqual([]);
    expect((await fieldRepository.find(spaceId, tableId, created!.id))?.enabled).toBe(false);

    expect(await fieldRepository.delete(spaceId, tableId, created!.id)).toBe(true);
    expect(await fieldRepository.find(spaceId, tableId, created!.id)).toBeUndefined();
    expect(await fieldRepository.delete(spaceId, tableId, created!.id)).toBe(false);
  });

  it("isolates fields by memory space and table (跨空间/跨表互不可见)", async () => {
    const services = createServices(createTestDatabase());
    const spaceA = await services.spaces.create("空间 A");
    const spaceB = await services.spaces.create("空间 B");
    const tableA = await services.tables.create(spaceA.id, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });
    const tableB = await services.tables.create(spaceB.id, {
      key: "clues",
      kind: "custom",
      name: "线索",
      description: "",
      prompt: "",
    });

    // 两个空间各自的表里都有 key=location 的字段
    const fieldA = await services.fields.create(spaceA.id, tableA!.id, {
      key: "location",
      name: "地点",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });
    const fieldB = await services.fields.create(spaceB.id, tableB!.id, {
      key: "location",
      name: "地点",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    // 同空间不同表也可以有相同 Key（唯一性按表内计）
    const tableA2 = await services.tables.create(spaceA.id, {
      key: "places",
      kind: "custom",
      name: "地点",
      description: "",
      prompt: "",
    });
    const fieldA2 = await services.fields.create(spaceA.id, tableA2!.id, {
      key: "location",
      name: "地点",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    expect(await services.fieldRepository.findByKey(spaceA.id, tableA!.id, "location" as MemoryFieldKey)).toEqual(fieldA);
    expect(await services.fieldRepository.findByKey(spaceB.id, tableB!.id, "location" as MemoryFieldKey)).toEqual(fieldB);
    expect(await services.fieldRepository.findByKey(spaceA.id, tableA2!.id, "location" as MemoryFieldKey)).toEqual(fieldA2);
    // 跨空间/跨表一律视为未命中
    expect(await services.fieldRepository.find(spaceB.id, tableA!.id, fieldA!.id)).toBeUndefined();
    expect(await services.fieldRepository.find(spaceA.id, tableA2!.id, fieldA!.id)).toBeUndefined();
    expect(await services.fieldRepository.update({ ...fieldA!, memorySpaceId: spaceB.id })).toBe(false);
    expect(await services.fieldRepository.update({ ...fieldA!, tableId: tableA2!.id })).toBe(false);
    expect(await services.fieldRepository.delete(spaceB.id, tableA!.id, fieldA!.id)).toBe(false);
    expect(await services.fieldRepository.list(spaceA.id, tableA!.id)).toEqual([fieldA]);
  });

  it("rejects a duplicate field key within the same table (core 规则)", async () => {
    const { fields, spaceId, tableId } = await setupFieldTest();
    await fields.create(spaceId, tableId, {
      key: "location",
      name: "地点",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    await expect(
      fields.create(spaceId, tableId, {
        key: "location",
        name: "另一个地点",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 1,
      }),
    ).rejects.toMatchObject({ type: "memory_field_key_conflict" });

    // 同表换 Key 即可创建
    const another = await fields.create(spaceId, tableId, {
      key: "location2",
      name: "另一个地点",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 1,
    });
    expect(another?.key).toBe("location2");
  });

  it("rejects changing a field type after creation (core 规则：类型不可变)", async () => {
    const { fields, spaceId, tableId } = await setupFieldTest();
    const created = await fields.create(spaceId, tableId, {
      key: "age",
      name: "年龄",
      type: "integer",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    await expect(
      fields.update(spaceId, tableId, created!.id, { type: "short_text" }),
    ).rejects.toMatchObject({ type: "memory_field_type_immutable" });

    // 同名同类型更新不受影响
    const updated = await fields.update(spaceId, tableId, created!.id, {
      type: "integer",
      name: "年龄（岁）",
    });
    expect(updated?.field.name).toBe("年龄（岁）");
  });

  it("rejects a reference field pointing outside the memory space (core 规则)", async () => {
    const { fields, spaces, tables, spaceId, tableId } = await setupFieldTest();
    const otherSpace = await spaces.create("另一个空间");
    const foreignTable = await tables.create(otherSpace.id, {
      key: "foreign",
      kind: "custom",
      name: "外部表",
      description: "",
      prompt: "",
    });

    await expect(
      fields.create(spaceId, tableId, {
        key: "related",
        name: "相关线索",
        type: "single_reference",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
        referenceTableId: foreignTable!.id,
      }),
    ).rejects.toMatchObject({ type: "memory_field_reference_table_invalid" });

    // 指向本空间内的表即可创建
    const valid = await fields.create(spaceId, tableId, {
      key: "related",
      name: "相关线索",
      type: "single_reference",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
      referenceTableId: tableId,
    });
    expect(valid?.referenceTableId).toBe(tableId);
  });

  it("validates select options and maxChars at creation (core 规则)", async () => {
    const { fields, spaceId, tableId } = await setupFieldTest();

    await expect(
      fields.create(spaceId, tableId, {
        key: "priority",
        name: "优先级",
        type: "single_select",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
        options: [],
      }),
    ).rejects.toMatchObject({ type: "memory_field_options_invalid" });

    await expect(
      fields.create(spaceId, tableId, {
        key: "priority",
        name: "优先级",
        type: "single_select",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
        options: ["高", "高"],
      }),
    ).rejects.toMatchObject({ type: "memory_field_options_invalid" });

    await expect(
      fields.create(spaceId, tableId, {
        key: "note",
        name: "备注",
        type: "short_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
        maxChars: 0,
      }),
    ).rejects.toMatchObject({ type: "memory_field_max_chars_invalid" });
  });

  it("lists fields ordered by position then id", async () => {
    const { fields, fieldRepository, spaceId, tableId } = await setupFieldTest();
    const second = await fields.create(spaceId, tableId, {
      key: "b",
      name: "字段 B",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 1,
    });
    const first = await fields.create(spaceId, tableId, {
      key: "a",
      name: "字段 A",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    expect(await fieldRepository.list(spaceId, tableId)).toEqual([first, second]);
  });

  it("protects a field used by the display strategy from disable/delete (core 规则)", async () => {
    const { fields, spaceId, tableId } = await setupFieldTest();
    const nameField = await fields.create(spaceId, tableId, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: true,
      prompt: "",
      enabled: true,
      position: 0,
    });
    await fields.setDisplayStrategy(spaceId, tableId, { type: "field", fieldId: nameField!.id });

    await expect(
      fields.update(spaceId, tableId, nameField!.id, { enabled: false }),
    ).rejects.toMatchObject({ type: "memory_field_used_by_display_strategy" });
    await expect(fields.delete(spaceId, tableId, nameField!.id)).rejects.toMatchObject({
      type: "memory_field_used_by_display_strategy",
    });
  });

  it("warns when disabling a required field (core 规则：停用必填字段)", async () => {
    const { fields, spaceId, tableId } = await setupFieldTest();
    const created = await fields.create(spaceId, tableId, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: true,
      prompt: "",
      enabled: true,
      position: 0,
    });

    const result = await fields.update(spaceId, tableId, created!.id, { enabled: false });

    expect(result?.warnings).toEqual(["停用必填字段后，Agent 可能无法创建合法记录"]);
    expect(result?.field.enabled).toBe(false);
  });

  it("service create returns undefined for a missing table", async () => {
    const { fields, spaceId } = await setupFieldTest();
    const created = await fields.create(spaceId, "missing" as MemoryTableId, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });
    expect(created).toBeUndefined();
  });
});
