import { describe, expect, it } from "vitest";
import type { MemoryField, MemoryFieldId, MemorySpaceId, MemoryTableId } from "../src/memory/domain/index.ts";
import { validateMemoryFieldValue } from "../src/memory/application/memory-record-validation.ts";

function field(overrides: Partial<MemoryField>): MemoryField {
  return {
    id: "field-1" as MemoryFieldId,
    memorySpaceId: "space-1" as MemorySpaceId,
    tableId: "table-1" as MemoryTableId,
    key: "current_time" as MemoryField["key"],
    name: "当前时间",
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
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

const STORY_TIME = {
  valuePattern:
    "^(?:20\\d{2}年\\d{1,2}月\\d{1,2}日(?:\\s*\\d{1,2}[:：]\\d{2}(?:[:：]\\d{2})?)?|第\\s*[0-9一二两三四五六七八九十]+\\s*天[·、]?.+)$",
  valuePatternMessage: "时间坐标二选一：有明确日期时填具体年月日（如：2025年5月14日 17:35）；否则填「第 N 天·时段」",
} as const;

describe("validateMemoryFieldValue 格式校验（valuePattern）", () => {
  it("匹配格式的值通过", () => {
    const f = field(STORY_TIME);
    expect(validateMemoryFieldValue(f, "第一天清晨")).toBe("第一天清晨");
    expect(validateMemoryFieldValue(f, "第二天傍晚")).toBe("第二天傍晚");
    expect(validateMemoryFieldValue(f, "第3天·深夜")).toBe("第3天·深夜");
    // 分隔符可选的宽格式：天数仍可解析（v3 曾填「第二天早晨至午间食堂」）
    expect(validateMemoryFieldValue(f, "第二天早晨至午间食堂")).toBe("第二天早晨至午间食堂");
    // 绝对时间：年月日（可有时分/时分秒）
    expect(validateMemoryFieldValue(f, "2025年5月14日 17:35")).toBe("2025年5月14日 17:35");
    expect(validateMemoryFieldValue(f, "2025年5月14日")).toBe("2025年5月14日");
    expect(validateMemoryFieldValue(f, "2025年05月14日17:35:20")).toBe("2025年05月14日17:35:20");
  });

  it("不匹配格式的值被拒，错误消息携带格式要求", () => {
    const f = field(STORY_TIME);
    expect(() => validateMemoryFieldValue(f, "黄昏（已回到宿舍）")).toThrowError(
      expect.objectContaining({
        type: "memory_record_field_value_pattern_mismatch",
        humanMsg: expect.stringContaining("2025年5月14日 17:35"),
      }),
    );
    expect(() => validateMemoryFieldValue(f, "当天午后")).toThrowError(
      expect.objectContaining({ type: "memory_record_field_value_pattern_mismatch" }),
    );
    expect(() => validateMemoryFieldValue(f, "放学后傍晚至次日清晨")).toThrowError(
      expect.objectContaining({ type: "memory_record_field_value_pattern_mismatch" }),
    );
  });

  it("空值与 null 跳过格式校验", () => {
    const f = field(STORY_TIME);
    expect(validateMemoryFieldValue(f, null)).toBeNull();
  });

  it("无 valuePattern 的字段不受影响", () => {
    const f = field();
    expect(validateMemoryFieldValue(f, "任意文本")).toBe("任意文本");
  });

  it("short_text_list 逐元素校验", () => {
    const f = field({ type: "short_text_list", valuePattern: "^第.+天$", valuePatternMessage: "天数格式" });
    expect(validateMemoryFieldValue(f, ["第一天", "第二天"])).toEqual(["第一天", "第二天"]);
    expect(() => validateMemoryFieldValue(f, ["第一天", "今天"])).toThrowError(
      expect.objectContaining({ type: "memory_record_field_value_pattern_mismatch" }),
    );
  });

  it("固定值校验（story_state.name = 世界状态）", () => {
    const f = field({ valuePattern: "^世界状态$", valuePatternMessage: "本表名称固定为「世界状态」" });
    expect(validateMemoryFieldValue(f, "世界状态")).toBe("世界状态");
    expect(() => validateMemoryFieldValue(f, "回到宿舍的晚餐之夜")).toThrowError(
      expect.objectContaining({ type: "memory_record_field_value_pattern_mismatch" }),
    );
  });

  it("maxChars 超限被拒（字符串与数组元素）", () => {
    const f = field({ maxChars: 10 });
    expect(validateMemoryFieldValue(f, "十个字以内的值")).toBe("十个字以内的值");
    expect(() => validateMemoryFieldValue(f, "这个值肯定超过十个字了没错吧")).toThrowError(
      expect.objectContaining({
        type: "memory_record_field_value_too_long",
        param: { fieldId: "field-1", maxChars: 10, actualLength: 14 },
        humanMsg: expect.stringContaining("超过上限 10 字"),
      }),
    );
    const listField = field({ type: "short_text_list", maxChars: 5 });
    expect(() => validateMemoryFieldValue(listField, ["短", "这个元素超过五个字了"])).toThrowError(
      expect.objectContaining({
        type: "memory_record_field_value_too_long",
        param: expect.objectContaining({ maxChars: 5 }),
      }),
    );
  });
});
