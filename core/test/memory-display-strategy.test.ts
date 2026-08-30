import { describe, expect, it } from "vitest";
import {
  remapMemoryTableDisplayStrategy,
  type MemoryFieldId,
  type MemoryTableDisplayStrategy,
} from "../src/memory/index.ts";
import {
  fieldId,
  FieldRepository,
  fieldService,
  memorySpaceId,
  tableId,
} from "./memory-field-test-support.ts";

/** 克隆/导入会把字段重生成全新 ID（旧 ID → 新 ID 映射表），策略必须跟着重映射。 */
const fieldIdMap = new Map<string, MemoryFieldId>([
  ["field-old-a", "field-new-a" as MemoryFieldId],
  ["field-old-b", "field-new-b" as MemoryFieldId],
]);

describe("remapMemoryTableDisplayStrategy", () => {
  it("field 策略：fieldId 重映射为新字段 ID", () => {
    const strategy: MemoryTableDisplayStrategy = {
      type: "field",
      fieldId: "field-old-a" as MemoryFieldId,
    };
    expect(remapMemoryTableDisplayStrategy(strategy, fieldIdMap)).toEqual({
      type: "field",
      fieldId: "field-new-a",
    });
  });

  it("template 策略：全部占位符按旧 ID → 新 ID 重映射，模板其余文本不变", () => {
    const strategy: MemoryTableDisplayStrategy = {
      type: "template",
      template: "{field-old-a} <-> {field-old-b}（第{field-old-b}条）",
    };
    expect(remapMemoryTableDisplayStrategy(strategy, fieldIdMap)).toEqual({
      type: "template",
      template: "{field-new-a} <-> {field-new-b}（第{field-new-b}条）",
    });
  });

  it("映射表里没有的字段 ID 保持原样（渲染层兜底为空，不丢信息）", () => {
    const strategy: MemoryTableDisplayStrategy = {
      type: "template",
      template: "{field-old-a}（{field-unknown}）",
    };
    expect(remapMemoryTableDisplayStrategy(strategy, fieldIdMap)).toEqual({
      type: "template",
      template: "{field-new-a}（{field-unknown}）",
    });
  });

  it("无显示策略原样返回 null", () => {
    expect(remapMemoryTableDisplayStrategy(null, fieldIdMap)).toBeNull();
  });
});

describe("memory table display strategy", () => {
  it("uses a short text field for display and protects that field from deletion", async () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    await fields.create(memorySpaceId, tableId, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: true,
      prompt: "",
      enabled: true,
      position: 0,
    });

    const updated = await fields.setDisplayStrategy(memorySpaceId, tableId, {
      type: "field",
      fieldId,
    });

    expect(updated?.displayStrategy).toEqual({ type: "field", fieldId });
    await expect(fields.delete(memorySpaceId, tableId, fieldId)).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_field_used_by_display_strategy",
        humanMsg: "请先指定不使用该字段的其他显示策略，再删除或停用该字段",
      }),
    );
    await expect(
      fields.update(memorySpaceId, tableId, fieldId, { enabled: false }),
    ).rejects.toThrowError(
      expect.objectContaining({ type: "memory_field_used_by_display_strategy" }),
    );
  });

  it("uses current-table fields in a derived display template", async () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    await fields.create(memorySpaceId, tableId, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: true,
      prompt: "",
      enabled: true,
      position: 0,
    });

    expect(
      (
        await fields.setDisplayStrategy(memorySpaceId, tableId, {
          type: "template",
          template: "线索：{field-1}",
        })
      )?.displayStrategy,
    ).toEqual({ type: "template", template: "线索：{field-1}" });
    await expect(
      fields.setDisplayStrategy(memorySpaceId, tableId, {
        type: "template",
        template: "{unknown-field}",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        type: "memory_table_display_strategy_invalid",
        humanMsg: "显示模板只能引用当前表中的字段",
      }),
    );
    await expect(fields.delete(memorySpaceId, tableId, fieldId)).rejects.toThrowError(
      expect.objectContaining({ type: "memory_field_used_by_display_strategy" }),
    );
  });
});
