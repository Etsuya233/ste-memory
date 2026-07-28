import { describe, expect, it } from "vitest";
import {
  fieldId,
  FieldRepository,
  fieldService,
  memorySpaceId,
  tableId,
} from "./memory-field-test-support.ts";

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
