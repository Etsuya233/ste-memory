import { describe, expect, it } from "vitest";
import type { MemoryMacro } from "../../../features/macros/macro-expression.ts";
import { macroWasSaved, mergeEditedMacro } from "./macros-model.ts";

const macro: MemoryMacro = {
  id: "a",
  name: "人物",
  enabled: true,
  expression: { language: "query", query: { table: "people", limit: 10 } },
  output: { format: "text", maxChars: null },
};
describe("macro editor persistence", () => {
  it("keeps unrelated macros added after the editor opened", () => {
    const other = { ...macro, id: "b", name: "地点" };
    const changed = { ...macro, name: "人物摘要" };
    expect(mergeEditedMacro([macro, other], macro, changed)).toEqual([changed, other]);
  });
  it("rejects replacing a macro changed since the editor opened", () => {
    expect(() =>
      mergeEditedMacro([{ ...macro, enabled: false }], macro, { ...macro, name: "新名字" }),
    ).toThrow("已变化");
  });
  it("recognizes persisted semantic classification without hiding output changes", () => {
    const desired: MemoryMacro = {
      ...macro,
      expression: {
        language: "sql",
        sql: "SELECT * FROM semantic_scores('people', '[\"all\"]', 'Alice')",
      },
    };
    const actual: MemoryMacro = {
      ...desired,
      enabled: false,
      expression: { ...desired.expression, usesSemantic: true } as MemoryMacro["expression"],
    };
    expect(macroWasSaved(actual, desired, true)).toBe(true);
    expect(macroWasSaved(actual, desired, false)).toBe(false);
    expect(
      macroWasSaved({ ...actual, output: { format: "json", maxChars: null } }, desired, true),
    ).toBe(false);
  });
  it("does not append a duplicate when a previous save already committed", () => {
    const desired = { ...macro, enabled: false };
    expect(mergeEditedMacro([desired], null, desired)).toEqual([desired]);
  });
});
