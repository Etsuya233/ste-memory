import { describe, expect, it } from "vitest";
import type { MemoryMacro } from "../../features/macros/macro-expression.ts";
import {
  macroFromEditorDraft,
  type ExpressionMacroDraft,
} from "./expression-macro-editor-model.ts";
const legacy: MemoryMacro = {
  id: "legacy-id",
  name: "旧宏",
  enabled: true,
  expression: {
    language: "sql",
    sources: [
      {
        name: "related",
        table: "events",
        groups: ["event_memory"],
        query: { context: "last_user_message" },
      },
    ],
    sql: "SELECT * FROM related WHERE 'related' = 'related' -- related 保持原文",
  },
  output: { format: "text", maxChars: null },
};
const draft: ExpressionMacroDraft = {
  name: "改名宏",
  enabled: false,
  language: "sql",
  query: "{}",
  sql: "SELECT * FROM related WHERE 'related' = 'related' -- related 保持原文",
  convertedLegacy: false,
  format: "json",
  maxChars: "2000",
};
describe("表达式宏编辑草稿", () => {
  it("旧 sources 元数据保存完整保留原表达式及身份", () => {
    const result = macroFromEditorDraft(legacy, { ...draft, sql: "不会替换旧 SQL" }, [legacy.name]);
    expect(result.id).toBe(legacy.id);
    expect(result.expression).toBe(legacy.expression);
    expect(result.name).toBe("改名宏");
    expect(result.enabled).toBe(false);
    expect(result.output).toEqual({ format: "json", maxChars: 2000 });
  });
  it("显式转换仅去 sources，不自动改写任何 SQL 字符", () => {
    const result = macroFromEditorDraft(legacy, { ...draft, convertedLegacy: true }, [legacy.name]);
    expect(result.expression).toEqual({ language: "sql", sql: draft.sql });
    expect(legacy.expression).toHaveProperty("sources");
    expect(result.id).toBe(legacy.id);
  });
  it("转换草稿采用手工内联 SQL，启停状态不靠函数名词法推断", () => {
    const sql = "SELECT * FROM semantic_scores('events', '[\"event_memory\"]', :last_user_message)";
    const result = macroFromEditorDraft(
      legacy,
      { ...draft, convertedLegacy: true, enabled: true, sql },
      [legacy.name],
    );
    expect(result.expression).toEqual({ language: "sql", sql });
    expect(result.enabled).toBe(true);
  });
  it("空 sources 无损归一为普通 SQL", () => {
    const initial: MemoryMacro = {
      ...legacy,
      expression: { language: "sql", sources: [], sql: "SELECT 1" },
    };
    expect(
      macroFromEditorDraft(initial, { ...draft, sql: "SELECT 'semantic_scores' AS literal" }, [
        legacy.name,
      ]).expression,
    ).toEqual({ language: "sql", sql: "SELECT 'semantic_scores' AS literal" });
  });
  it("保存前拒绝重复名称和无效输出预算", () => {
    expect(() => macroFromEditorDraft(legacy, draft, [legacy.name, draft.name])).toThrow(
      "宏名已存在",
    );
    expect(() => macroFromEditorDraft(legacy, { ...draft, maxChars: "-1" }, [legacy.name])).toThrow(
      "宏定义无效",
    );
  });
});
