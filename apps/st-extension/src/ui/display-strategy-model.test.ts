/**
 * 显示策略编辑器 seam（ticket 10）测试：草稿校验（与 core setDisplayStrategy 同规则）、
 * 摘要文案、依赖字段集合、预览行摘要。
 */
import { describe, expect, it } from "vitest";
import {
  type MemoryField,
  type MemoryFieldId,
  type MemoryFieldKey,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core/memory";
import {
  displayFieldCandidates,
  displayStrategyDependentFieldIds,
  displayStrategyFromDraft,
  displayStrategySummary,
  emptyDisplayStrategyDraft,
  payloadSummary,
  templateFieldRef,
  validateDisplayStrategyDraft,
  type DisplayStrategyDraft,
} from "./display-strategy-model.ts";

function field(
  id: string,
  type: MemoryField["type"] = "short_text",
  enabled = true,
  name = id,
): MemoryField {
  return {
    id: id as MemoryFieldId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    key: id as MemoryFieldKey,
    name,
    type,
    required: false,
    prompt: "",
    enabled,
    position: 0,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
  } as MemoryField;
}

const fields = [
  field("f-name", "short_text", true, "姓名"),
  field("f-note", "long_text", true, "备注"),
  field("f-disabled", "short_text", false, "停用字段"),
  field("f-age", "integer", true, "年龄"),
];

describe("validateDisplayStrategyDraft（与 core setDisplayStrategy 同规则）", () => {
  it("field 策略：选中启用短文本字段 → 通过", () => {
    const draft: DisplayStrategyDraft = { type: "field", fieldId: "f-name", template: "" };
    expect(validateDisplayStrategyDraft(draft, fields)).toBeNull();
  });

  it("field 策略：未选 / 非短文本 / 停用字段 → 报错", () => {
    for (const fieldId of ["", "f-age", "f-disabled", "f-missing"]) {
      const draft: DisplayStrategyDraft = { type: "field", fieldId, template: "" };
      expect(validateDisplayStrategyDraft(draft, fields)?.message).toBe(
        "请选择当前表中已启用的短文本字段",
      );
    }
  });

  it("template 策略：至少一个 {字段引用} 且引用启用字段 → 通过", () => {
    const draft: DisplayStrategyDraft = {
      type: "template",
      fieldId: "",
      template: "{f-name}（{f-note}）",
    };
    expect(validateDisplayStrategyDraft(draft, fields)).toBeNull();
  });

  it("template 策略：无占位符 → 报错", () => {
    const draft: DisplayStrategyDraft = { type: "template", fieldId: "", template: "纯文本" };
    expect(validateDisplayStrategyDraft(draft, fields)?.message).toBe(
      "显示模板必须用 {字段引用} 引用至少一个字段",
    );
  });

  it("template 策略：引用不存在或停用的字段 → 报错", () => {
    for (const template of ["{f-missing}", "{f-disabled}"]) {
      const draft: DisplayStrategyDraft = { type: "template", fieldId: "", template };
      expect(validateDisplayStrategyDraft(draft, fields)?.message).toBe(
        "显示模板只能引用当前表中已启用的字段",
      );
    }
  });
});

describe("emptyDisplayStrategyDraft / displayStrategyFromDraft", () => {
  it("无策略 → 默认 field 类型空草稿", () => {
    expect(emptyDisplayStrategyDraft(null)).toEqual({
      type: "field",
      fieldId: "",
      template: "",
    });
  });

  it("field 策略 → 回填 fieldId", () => {
    expect(
      emptyDisplayStrategyDraft({ type: "field", fieldId: "f-name" as MemoryFieldId }),
    ).toEqual({ type: "field", fieldId: "f-name", template: "" });
  });

  it("template 策略 → 回填 template", () => {
    expect(emptyDisplayStrategyDraft({ type: "template", template: "{f-name}" })).toEqual({
      type: "template",
      fieldId: "",
      template: "{f-name}",
    });
  });

  it("草稿 → core 策略对象", () => {
    expect(displayStrategyFromDraft({ type: "field", fieldId: "f-name", template: "" })).toEqual({
      type: "field",
      fieldId: "f-name",
    });
    expect(
      displayStrategyFromDraft({ type: "template", fieldId: "", template: "{f-name}" }),
    ).toEqual({ type: "template", template: "{f-name}" });
  });
});

describe("displayStrategySummary", () => {
  it("未配置 / 显示字段 / 显示模板", () => {
    expect(displayStrategySummary(null, fields)).toBe("未配置显示策略");
    expect(
      displayStrategySummary({ type: "field", fieldId: "f-name" as MemoryFieldId }, fields),
    ).toBe("显示字段：姓名");
    expect(
      displayStrategySummary({ type: "template", template: "{f-name} <-> {f-note}" }, fields),
    ).toBe("显示模板：{f-name} <-> {f-note}");
  });
});

describe("displayStrategyDependentFieldIds", () => {
  it("field 策略 = 显示字段；template 策略 = 全部引用", () => {
    expect(
      displayStrategyDependentFieldIds({ type: "field", fieldId: "f-name" as MemoryFieldId }),
    ).toEqual(new Set(["f-name"]));
    expect(
      displayStrategyDependentFieldIds({ type: "template", template: "{f-name}{f-note}" }),
    ).toEqual(new Set(["f-name", "f-note"]));
    expect(displayStrategyDependentFieldIds(null)).toEqual(new Set());
  });
});

describe("payloadSummary / templateFieldRef / displayFieldCandidates", () => {
  it("字段值摘要：按字段名拼接、空值跳过、超长截断", () => {
    const payload = { "f-name": "顾川", "f-note": "旅人", "f-missing": "孤儿值" };
    expect(payloadSummary(payload, fields)).toBe("姓名: 顾川 · 备注: 旅人");
    expect(payloadSummary({ "f-name": "顾川" }, fields, 4)).toBe("姓名: …");
    expect(payloadSummary({}, fields)).toBe("");
  });

  it("模板引用片段 = {fieldId}", () => {
    expect(templateFieldRef("f-name" as MemoryFieldId)).toBe("{f-name}");
  });

  it("field 策略候选 = 启用短文本字段", () => {
    expect(displayFieldCandidates(fields).map((item) => item.id)).toEqual(["f-name"]);
  });
});
