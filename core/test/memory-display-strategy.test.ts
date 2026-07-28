import { describe, expect, it } from "vitest";
import {
  fieldId,
  FieldRepository,
  fieldService,
  memorySpaceId,
  tableId,
} from "./memory-field-test-support.ts";

describe("memory table display strategy", () => {
  it("uses a short text field for display and protects that field from deletion", () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    fields.create(memorySpaceId, tableId, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: true,
      prompt: "",
      enabled: true,
      position: 0,
    });

    const updated = fields.setDisplayStrategy(memorySpaceId, tableId, {
      type: "field",
      fieldId,
    });

    expect(updated?.displayStrategy).toEqual({ type: "field", fieldId });
    expect(() => fields.delete(memorySpaceId, tableId, fieldId)).toThrowError(
      expect.objectContaining({
        type: "memory_field_used_by_display_strategy",
        humanMsg: "请先指定不使用该字段的其他显示策略，再删除或停用该字段",
      }),
    );
    expect(() => fields.update(memorySpaceId, tableId, fieldId, { enabled: false })).toThrowError(
      expect.objectContaining({ type: "memory_field_used_by_display_strategy" }),
    );
  });

  it("uses current-table fields in a derived display template", () => {
    const repository = new FieldRepository();
    const fields = fieldService(repository);
    fields.create(memorySpaceId, tableId, {
      key: "name",
      name: "名称",
      type: "short_text",
      required: true,
      prompt: "",
      enabled: true,
      position: 0,
    });

    expect(
      fields.setDisplayStrategy(memorySpaceId, tableId, {
        type: "template",
        template: "线索：{field-1}",
      })?.displayStrategy,
    ).toEqual({ type: "template", template: "线索：{field-1}" });
    expect(() =>
      fields.setDisplayStrategy(memorySpaceId, tableId, {
        type: "template",
        template: "{unknown-field}",
      }),
    ).toThrowError(
      expect.objectContaining({
        type: "memory_table_display_strategy_invalid",
        humanMsg: "显示模板只能引用当前表中的字段",
      }),
    );
    expect(() => fields.delete(memorySpaceId, tableId, fieldId)).toThrowError(
      expect.objectContaining({ type: "memory_field_used_by_display_strategy" }),
    );
  });
});
