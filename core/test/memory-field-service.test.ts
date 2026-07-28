import type { MemorySpaceId, MemoryTableId } from "../src/index.ts";
import { describe, expect, it } from "vitest";
import {
  fieldId,
  FieldRepository,
  fieldService,
  memorySpaceId,
  now,
  tableId,
} from "./memory-field-test-support.ts";

describe("MemoryFieldService", () => {
  it("creates a select field with fixed options", () => {
    const repository = new FieldRepository();

    const created = fieldService(repository).create(memorySpaceId, tableId, {
      key: "status",
      name: "状态",
      type: "single_select",
      required: true,
      prompt: "只使用约定状态。",
      enabled: true,
      position: 0,
      options: ["进行中", "已解决"],
    });

    expect(created).toEqual({
      id: fieldId,
      memorySpaceId,
      tableId,
      key: "status",
      name: "状态",
      type: "single_select",
      required: true,
      prompt: "只使用约定状态。",
      enabled: true,
      position: 0,
      options: ["进行中", "已解决"],
      referenceTableId: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(repository.fields.get(fieldId)).toEqual(created);
  });

  it("allows reference fields to target only a table in the same memory space", () => {
    const repository = new FieldRepository();
    const targetTableId = "table-2" as MemoryTableId;
    const foreignTableId = "table-3" as MemoryTableId;
    const foreignSpaceId = "space-2" as MemorySpaceId;
    const fields = fieldService(repository);
    repository.tables.set(targetTableId, {
      ...repository.tables.get(tableId)!,
      id: targetTableId,
      name: "人物",
    });
    repository.tables.set(foreignTableId, {
      ...repository.tables.get(tableId)!,
      id: foreignTableId,
      memorySpaceId: foreignSpaceId,
      name: "另一空间的人物",
    });

    expect(() =>
      fields.create(memorySpaceId, tableId, {
        key: "related_characters",
        name: "相关人物",
        type: "multi_reference",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
        referenceTableId: foreignTableId,
      }),
    ).toThrowError(
      expect.objectContaining({
        type: "memory_field_reference_table_invalid",
        humanMsg: "引用字段的目标表必须属于当前记忆空间",
      }),
    );

    const created = fields.create(memorySpaceId, tableId, {
      key: "related_characters",
      name: "相关人物",
      type: "multi_reference",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
      referenceTableId: targetTableId,
    });
    expect(created?.referenceTableId).toBe(targetTableId);
  });

  it("rejects a select field without distinct fixed options", () => {
    const fields = fieldService(new FieldRepository());

    expect(() =>
      fields.create(memorySpaceId, tableId, {
        key: "status",
        name: "状态",
        type: "multi_select",
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
        options: ["进行中", " 进行中 "],
      }),
    ).toThrowError(
      expect.objectContaining({
        type: "memory_field_options_invalid",
        humanMsg: "单选和多选字段需要互不重复的非空固定选项",
      }),
    );
  });

  it("does not allow changing a field type after creation", () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    fields.create(memorySpaceId, tableId, {
      key: "summary",
      name: "摘要",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    expect(() =>
      fields.update(memorySpaceId, tableId, fieldId, { type: "long_text" }),
    ).toThrowError(
      expect.objectContaining({
        type: "memory_field_type_immutable",
        humanMsg: "字段创建后不能修改类型",
      }),
    );
    expect(repository.fields.get(fieldId)?.type).toBe("short_text");
  });

  it("rejects duplicate field keys in the same table", () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    fields.create(memorySpaceId, tableId, {
      key: "summary",
      name: "摘要",
      type: "short_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 0,
    });

    expect(() =>
      fields.create(memorySpaceId, tableId, {
        key: "summary",
        name: "另一字段",
        type: "long_text",
        required: false,
        prompt: "",
        enabled: true,
        position: 1,
      }),
    ).toThrowError(expect.objectContaining({ type: "memory_field_key_conflict" }));
  });

  it("updates field configuration and warns when a required field is disabled", () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    fields.create(memorySpaceId, tableId, {
      key: "status",
      name: "状态",
      type: "single_select",
      required: true,
      prompt: "旧 Prompt",
      enabled: true,
      position: 0,
      options: ["进行中", "已解决"],
    });

    const result = fields.update(memorySpaceId, tableId, fieldId, {
      name: "剧情状态",
      required: true,
      prompt: "使用最新状态。",
      enabled: false,
      position: 2,
      options: ["进行中", "暂停", "已解决"],
    });

    expect(result).toEqual({
      field: {
        ...repository.fields.get(fieldId),
        name: "剧情状态",
        prompt: "使用最新状态。",
        enabled: false,
        position: 2,
        options: ["进行中", "暂停", "已解决"],
      },
      warnings: ["停用必填字段后，Agent 可能无法创建合法记录"],
    });
    expect(repository.fields.get(fieldId)).toEqual(result?.field);
  });

  it("lists fields in display order and physically deletes a field", () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    fields.create(memorySpaceId, tableId, {
      key: "summary",
      name: "摘要",
      type: "long_text",
      required: false,
      prompt: "",
      enabled: true,
      position: 3,
    });

    expect(fields.list(memorySpaceId, tableId)).toMatchObject([
      { id: fieldId, name: "摘要", position: 3 },
    ]);
    expect(fields.delete(memorySpaceId, tableId, fieldId)).toBe(true);
    expect(fields.find(memorySpaceId, tableId, fieldId)).toBeUndefined();
  });
});
