import { describe, expect, it } from "vitest";
import type { MemoryField, MemoryFieldType, MemoryRecord } from "@ste-memory/core/memory";
import {
  emptyRecordFormDraft,
  joinListText,
  recordFieldValueText,
  recordFormDraftFromPayload,
  recordFormPatchFromDraft,
  recordPayloadFromDraft,
  splitListText,
  validateRecordFormDraft,
  type RecordFormDraft,
} from "./record-form-model.ts";

function field(overrides: Partial<MemoryField> & { readonly type?: MemoryFieldType }): MemoryField {
  return {
    id: "field-1" as MemoryField["id"],
    memorySpaceId: "space-1" as MemoryField["memorySpaceId"],
    tableId: "table-1" as MemoryField["tableId"],
    key: "name" as MemoryField["key"],
    name: "名称",
    type: "short_text",
    required: false,
    prompt: "",
    enabled: true,
    position: 0,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function record(payload: MemoryRecord["payload"] = {}): MemoryRecord {
  return {
    id: "record-1" as MemoryRecord["id"],
    memorySpaceId: "space-1" as MemoryRecord["memorySpaceId"],
    tableId: "table-1" as MemoryRecord["tableId"],
    payload,
    fieldEvidence: { "field-1": [] },
    displayText: "显示文本",
    source: { type: "manual" },
    revisionId: "rev-1" as MemoryRecord["revisionId"],
    revisionSource: "user",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("splitListText / joinListText（短文本列表分隔）", () => {
  it("中文/英文逗号、顿号、换行均可分隔，trim 并去空", () => {
    expect(splitListText("苹果，香蕉、橘子, 梨\n葡萄")).toEqual([
      "苹果",
      "香蕉",
      "橘子",
      "梨",
      "葡萄",
    ]);
    expect(splitListText("  ,  ， ")).toEqual([]);
  });

  it("joinListText 用顿号连接", () => {
    expect(joinListText(["a", "b"])).toBe("a、b");
  });
});

describe("emptyRecordFormDraft（空草稿）", () => {
  it("boolean=false、列表类=[]、其余为空串", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "boolean" }),
      field({ id: "f2" as MemoryField["id"], type: "short_text_list" }),
      field({ id: "f3" as MemoryField["id"], type: "multi_select" }),
      field({ id: "f4" as MemoryField["id"], type: "date" }),
      field({ id: "f5" as MemoryField["id"], type: "single_reference" }),
    ];
    const draft = emptyRecordFormDraft(fields);
    expect(draft.values["f1"]).toBe(false);
    expect(draft.values["f2"]).toEqual([]);
    expect(draft.values["f3"]).toEqual([]);
    expect(draft.values["f4"]).toBe("");
    expect(draft.values["f5"]).toBe("");
  });
});

describe("recordFormDraftFromPayload（编辑回填）", () => {
  it("datetime 存储形态转 datetime-local 输入形态", () => {
    const fields = [field({ id: "f1" as MemoryField["id"], type: "datetime" })];
    const draft = recordFormDraftFromPayload(fields, { f1: "2026-08-09 12:30:00" });
    expect(draft.values["f1"]).toBe("2026-08-09T12:30");
  });

  it("列表值回填为数组、null 回填为空串", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text_list" }),
      field({ id: "f2" as MemoryField["id"], type: "short_text" }),
    ];
    const draft = recordFormDraftFromPayload(fields, { f1: ["a", "b"], f2: null });
    expect(draft.values["f1"]).toEqual(["a", "b"]);
    expect(draft.values["f2"]).toBe("");
  });
});

describe("validateRecordFormDraft（逐字段前置校验，语义与 core 一致）", () => {
  it("必填空值报错（文本/数字/日期/单选/引用各自文案）", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text", required: true }),
      field({ id: "f2" as MemoryField["id"], type: "integer", required: true }),
      field({ id: "f3" as MemoryField["id"], type: "date", required: true }),
      field({
        id: "f4" as MemoryField["id"],
        type: "single_select",
        required: true,
        options: ["甲"],
      }),
    ];
    const errors = validateRecordFormDraft(fields, emptyRecordFormDraft(fields));
    expect(errors["f1"]).toContain("请填写");
    expect(errors["f2"]).toContain("请填写");
    expect(errors["f3"]).toContain("请填写");
    expect(errors["f4"]).toContain("请选择");
  });

  it("整数/小数格式错误", () => {
    const fields = [field({ id: "f1" as MemoryField["id"], type: "integer" })];
    expect(validateRecordFormDraft(fields, { values: { f1: "3.5" } })["f1"]).toBe(
      "「名称」必须是整数",
    );
    expect(validateRecordFormDraft(fields, { values: { f1: "abc" } })["f1"]).toBe(
      "「名称」必须是整数",
    );
    expect(validateRecordFormDraft(fields, { values: { f1: "3" } })).toEqual({});
  });

  it("日期/时间格式错误", () => {
    const dateFields = [field({ id: "f1" as MemoryField["id"], type: "date" })];
    expect(validateRecordFormDraft(dateFields, { values: { f1: "2026-13-99" } })["f1"]).toContain(
      "YYYY-MM-DD",
    );
    expect(validateRecordFormDraft(dateFields, { values: { f1: "2026-08-09" } })).toEqual({});

    const dtFields = [field({ id: "f2" as MemoryField["id"], type: "datetime" })];
    expect(
      validateRecordFormDraft(dtFields, { values: { f2: "2026-08-09T25:61" } })["f2"],
    ).toContain("YYYY-MM-DD HH:mm");
    expect(validateRecordFormDraft(dtFields, { values: { f2: "2026-08-09T12:30" } })).toEqual({});
  });

  it("单选选项非法 / 多选含非法项 / 列表重复项", () => {
    const select = field({
      id: "f1" as MemoryField["id"],
      type: "single_select",
      options: ["甲", "乙"],
    });
    expect(validateRecordFormDraft([select], { values: { f1: "丙" } })["f1"]).toContain("选项无效");

    const multi = field({
      id: "f2" as MemoryField["id"],
      type: "multi_select",
      options: ["甲", "乙"],
    });
    expect(validateRecordFormDraft([multi], { values: { f2: ["甲", "丙"] } })["f2"]).toContain(
      "无效选项",
    );

    const list = field({ id: "f3" as MemoryField["id"], type: "short_text_list" });
    expect(validateRecordFormDraft([list], { values: { f3: ["a", "a"] } })["f3"]).toContain(
      "不能重复",
    );
  });

  it("可选空值通过校验", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text" }),
      field({ id: "f2" as MemoryField["id"], type: "multi_select", options: ["甲"] }),
      field({ id: "f3" as MemoryField["id"], type: "multi_reference" }),
    ];
    expect(validateRecordFormDraft(fields, emptyRecordFormDraft(fields))).toEqual({});
  });
});

describe("recordPayloadFromDraft（草稿 → payload 转换）", () => {
  it("空文本→null、列表分隔、整数解析、布尔、日期原样、datetime 规范化", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text" }),
      field({ id: "f2" as MemoryField["id"], type: "short_text_list" }),
      field({ id: "f3" as MemoryField["id"], type: "integer" }),
      field({ id: "f4" as MemoryField["id"], type: "boolean" }),
      field({ id: "f5" as MemoryField["id"], type: "date" }),
      field({ id: "f6" as MemoryField["id"], type: "datetime" }),
      field({ id: "f7" as MemoryField["id"], type: "decimal" }),
    ];
    const payload = recordPayloadFromDraft(fields, {
      values: {
        f1: "  文本  ",
        f2: "a、b, c",
        f3: "42",
        f4: true,
        f5: "2026-08-09",
        f6: "2026-08-09T12:30",
        f7: "3.14",
      },
    });
    expect(payload["f1"]).toBe("  文本  ");
    expect(payload["f2"]).toEqual(["a", "b", "c"]);
    expect(payload["f3"]).toBe(42);
    expect(payload["f4"]).toBe(true);
    expect(payload["f5"]).toBe("2026-08-09");
    expect(payload["f6"]).toBe("2026-08-09 12:30:00");
    expect(payload["f7"]).toBe(3.14);
  });

  it("空值按类型落 null / [] / false", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text" }),
      field({ id: "f2" as MemoryField["id"], type: "integer" }),
      field({ id: "f3" as MemoryField["id"], type: "multi_select", options: ["甲"] }),
      field({ id: "f4" as MemoryField["id"], type: "boolean" }),
      field({ id: "f5" as MemoryField["id"], type: "single_select", options: ["甲"] }),
    ];
    const payload = recordPayloadFromDraft(fields, emptyRecordFormDraft(fields));
    expect(payload["f1"]).toBeNull();
    expect(payload["f2"]).toBeNull();
    expect(payload["f3"]).toEqual([]);
    expect(payload["f4"]).toBe(false);
    expect(payload["f5"]).toBeNull();
  });

  it("datetime 带秒输入原样保留", () => {
    const fields = [field({ id: "f1" as MemoryField["id"], type: "datetime" })];
    const payload = recordPayloadFromDraft(fields, { values: { f1: "2026-08-09T12:30:45" } });
    expect(payload["f1"]).toBe("2026-08-09 12:30:45");
  });
});

describe("recordFormPatchFromDraft（编辑补丁差异）", () => {
  it("无变化 → changed=false，patch 为空", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text" }),
      field({ id: "f2" as MemoryField["id"], type: "boolean" }),
    ];
    const current = record({ f1: "旧值", f2: true });
    const draft = recordFormDraftFromPayload(fields, current.payload);
    const result = recordFormPatchFromDraft(fields, current, draft);
    expect(result.changed).toBe(false);
    expect(result.patch).toEqual({});
  });

  it("只带变化字段（未动字段不进 patch，保护 Agent 证据）", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text" }),
      field({ id: "f2" as MemoryField["id"], type: "short_text" }),
    ];
    const current = record({ f1: "旧值", f2: "不动" });
    const draft: RecordFormDraft = {
      values: { ...recordFormDraftFromPayload(fields, current.payload).values, f1: "新值" },
    };
    const result = recordFormPatchFromDraft(fields, current, draft);
    expect(result.changed).toBe(true);
    expect(Object.keys(result.patch)).toEqual(["f1"]);
    expect(result.patch["f1"]).toBe("新值");
  });

  it("数组变化按内容比较", () => {
    const fields = [field({ id: "f1" as MemoryField["id"], type: "short_text_list" })];
    const current = record({ f1: ["a", "b"] });
    const unchanged = recordFormDraftFromPayload(fields, current.payload);
    expect(recordFormPatchFromDraft(fields, current, unchanged).changed).toBe(false);
    const draft: RecordFormDraft = {
      values: { ...unchanged.values, f1: ["a"] },
    };
    expect(recordFormPatchFromDraft(fields, current, draft).changed).toBe(true);
  });
});

describe("recordFieldValueText（详情展示）", () => {
  it("null/空数组=—、布尔=是/否、数组=顿号连接", () => {
    const f = field({});
    expect(recordFieldValueText(f, null)).toBe("—");
    expect(recordFieldValueText(f, undefined)).toBe("—");
    expect(recordFieldValueText(f, true)).toBe("是");
    expect(recordFieldValueText(f, false)).toBe("否");
    expect(recordFieldValueText(f, ["a", "b"])).toBe("a、b");
    expect(recordFieldValueText(f, [])).toBe("—");
    expect(recordFieldValueText(f, "文本")).toBe("文本");
    expect(recordFieldValueText(f, 42)).toBe("42");
  });

  it("引用字段：有标签映射时解析为目标记录显示文本，未知 id 回退原 id", () => {
    const single = field({
      type: "single_reference",
      referenceTableId: "t2" as MemoryField["referenceTableId"],
    });
    const multi = field({
      type: "multi_reference",
      referenceTableId: "t2" as MemoryField["referenceTableId"],
    });
    const labels = new Map([
      ["char-1", "秋元悦也"],
      ["char-2", "平野健介"],
    ]);
    expect(recordFieldValueText(single, "char-1", labels)).toBe("秋元悦也");
    expect(recordFieldValueText(single, "char-missing", labels)).toBe("char-missing");
    expect(recordFieldValueText(single, "", labels)).toBe("—");
    expect(recordFieldValueText(multi, ["char-1", "char-missing"], labels)).toBe(
      "秋元悦也、char-missing",
    );
    expect(recordFieldValueText(multi, [], labels)).toBe("—");
  });

  it("引用字段：无标签映射（目标表未加载）时显示原 id", () => {
    const single = field({
      type: "single_reference",
      referenceTableId: "t2" as MemoryField["referenceTableId"],
    });
    const multi = field({
      type: "multi_reference",
      referenceTableId: "t2" as MemoryField["referenceTableId"],
    });
    expect(recordFieldValueText(single, "char-1")).toBe("char-1");
    expect(recordFieldValueText(multi, ["char-1", "char-2"])).toBe("char-1、char-2");
  });
});

describe("recordFormPatchFromDraft（datetime 往返）", () => {
  it("存量记录带秒值 + 未编辑 datetime：无关字段编辑不把秒清零", () => {
    const fields = [
      field({ id: "f1" as MemoryField["id"], type: "short_text" }),
      field({ id: "f2" as MemoryField["id"], type: "datetime" }),
    ];
    const current = record({ f1: "旧值", f2: "2026-07-28 10:00:30" });
    const draft: RecordFormDraft = {
      // 草稿回填截秒（datetime-local 分钟精度）；只改 f1
      values: { ...recordFormDraftFromPayload(fields, current.payload).values, f1: "新值" },
    };
    const result = recordFormPatchFromDraft(fields, current, draft);
    expect(result.changed).toBe(true);
    expect(Object.keys(result.patch)).toEqual(["f1"]);
  });

  it("真正编辑 datetime 分钟 → 进入 patch 并规范化补 :00 秒", () => {
    const fields = [field({ id: "f1" as MemoryField["id"], type: "datetime" })];
    const current = record({ f1: "2026-07-28 10:00:30" });
    const draft: RecordFormDraft = {
      values: { f1: "2026-07-28T11:00" },
    };
    const result = recordFormPatchFromDraft(fields, current, draft);
    expect(result.patch).toEqual({ f1: "2026-07-28 11:00:00" });
  });

  it("清空 datetime → patch 带 null", () => {
    const fields = [field({ id: "f1" as MemoryField["id"], type: "datetime" })];
    const current = record({ f1: "2026-07-28 10:00:30" });
    const draft: RecordFormDraft = { values: { f1: "" } };
    const result = recordFormPatchFromDraft(fields, current, draft);
    expect(result.patch).toEqual({ f1: null });
  });
});
