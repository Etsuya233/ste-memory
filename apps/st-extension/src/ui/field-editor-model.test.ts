import type { MemoryField, MemoryFieldId, MemoryFieldType } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import {
  emptyFieldDraft,
  fieldDraftFromField,
  fieldTypeNeedsOptions,
  fieldTypeNeedsReference,
  parseOptionsText,
  swapAdjacentFieldPositions,
  validateFieldDraft,
} from "./field-editor-model.ts";

function makeField(overrides: Partial<MemoryField> = {}): MemoryField {
  return {
    id: "field-1" as MemoryFieldId,
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
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("fieldTypeNeedsOptions / fieldTypeNeedsReference（类型 → 配置形态映射）", () => {
  it("仅单选/多选需要固定选项", () => {
    for (const type of ["single_select", "multi_select"] as const) {
      expect(fieldTypeNeedsOptions(type)).toBe(true);
    }
    for (const type of [
      "short_text",
      "long_text",
      "integer",
      "boolean",
      "single_reference",
    ] as const) {
      expect(fieldTypeNeedsOptions(type)).toBe(false);
    }
  });

  it("仅单引用/多引用需要引用目标表", () => {
    for (const type of ["single_reference", "multi_reference"] as const) {
      expect(fieldTypeNeedsReference(type)).toBe(true);
    }
    expect(fieldTypeNeedsReference("single_select")).toBe(false);
  });
});

describe("parseOptionsText（固定选项文本解析）", () => {
  it("按行拆分、trim、去空行", () => {
    expect(parseOptionsText(" 甲 \n\n乙\n 丙 ")).toEqual(["甲", "乙", "丙"]);
  });

  it("空文本 → 空数组", () => {
    expect(parseOptionsText("  \n\n ")).toEqual([]);
  });
});

describe("validateFieldDraft（字段草稿本地校验）", () => {
  it("空 key / 空名称报错", () => {
    const errors = validateFieldDraft(emptyFieldDraft("short_text"), []);
    expect(errors.key).toBe("字段 Key 不能为空");
    expect(errors.name).toBe("字段名称不能为空");
  });

  it("key 与同表其他字段重复报错", () => {
    const draft = { ...emptyFieldDraft("short_text"), key: "name", name: "名称" };
    const errors = validateFieldDraft(draft, ["name", "age"]);
    expect(errors.key).toBe("同一表格内的字段 Key 不能重复");
  });

  it("单选类型缺少/重复选项报错", () => {
    const base = { ...emptyFieldDraft("single_select"), key: "status", name: "状态" };
    expect(validateFieldDraft(base, []).options).toBe("单选和多选字段需要互不重复的非空固定选项");
    expect(validateFieldDraft({ ...base, optionsText: "甲\n甲" }, []).options).toBeDefined();
    expect(validateFieldDraft({ ...base, optionsText: "甲\n乙" }, [])).toEqual({});
  });

  it("引用类型未选目标表报错", () => {
    const draft = {
      ...emptyFieldDraft("single_reference"),
      key: "target",
      name: "目标",
    };
    expect(validateFieldDraft(draft, []).reference).toBe("请选择引用目标表");
  });

  it("合法草稿无错误", () => {
    const draft = {
      ...emptyFieldDraft("short_text"),
      key: "name",
      name: "名称",
    };
    expect(validateFieldDraft(draft, [])).toEqual({});
  });
});

describe("swapAdjacentFieldPositions（上移/下移交换）", () => {
  const fields = ["a", "b", "c"].map((key, index) =>
    makeField({
      id: `field-${key}` as MemoryFieldId,
      key: key as MemoryField["key"],
      position: index,
    }),
  );

  it("中间字段下移与后一个交换 position", () => {
    const changes = swapAdjacentFieldPositions(fields, 1, 1);
    expect(changes).toEqual([
      { id: "field-b" as MemoryFieldId, position: 2 },
      { id: "field-c" as MemoryFieldId, position: 1 },
    ]);
  });

  it("顶部字段上移越界返回空数组", () => {
    expect(swapAdjacentFieldPositions(fields, 0, -1)).toEqual([]);
  });

  it("底部字段下移越界返回空数组", () => {
    expect(swapAdjacentFieldPositions(fields, 2, 1)).toEqual([]);
  });
});

describe("emptyFieldDraft / fieldDraftFromField（草稿构造）", () => {
  it("空草稿默认启用、非必填、无选项/引用", () => {
    const draft = emptyFieldDraft("long_text");
    expect(draft).toMatchObject({
      key: "",
      name: "",
      type: "long_text",
      required: false,
      enabled: true,
      optionsText: "",
      referenceTableId: "",
    });
  });

  it("既有字段 → 草稿：选项按行展开、引用保留", () => {
    const field = makeField({
      type: "multi_select" as MemoryFieldType,
      options: ["甲", "乙"],
      referenceTableId: "table-2" as MemoryField["referenceTableId"],
    });
    const draft = fieldDraftFromField(field);
    expect(draft.optionsText).toBe("甲\n乙");
    expect(draft.referenceTableId).toBe("table-2");
    expect(draft.type).toBe("multi_select");
  });
});
