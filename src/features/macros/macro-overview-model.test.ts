/**
 * 宏内容一览 model（issue 01）：快照聚合纯逻辑单测——
 * 行序（默认快照 → 全局视图 → 聊天 Scope 宏 → 内置宏 → Agent 预设宏）、
 * 花括号宏名包装、前缀为空时记忆宏家族不列（Agent 预设宏始终列出）、
 * 文本透传 = 快照实际值。
 */
import { describe, expect, it } from "vitest";
import { buildMacroOverviewRows, type MacroOverviewInput } from "./macro-overview-model.ts";

const DIGEST_SUMMARY = "可用表与字段（key 是工具参数取值...）";
const DEFAULT_PROMPT = "你是记忆表格填写助手...";

function input(overrides: Partial<MacroOverviewInput> = {}): MacroOverviewInput {
  return {
    prefix: "ste",
    defaultSnapshot: DIGEST_SUMMARY,
    views: [
      { name: "人物", text: "人物快照" },
      { name: "地点", text: "" },
    ],
    chatScopeMacros: [{ name: "本话", text: "聊天宏快照" }],
    builtin: [
      { name: "full", text: "全表快照" },
      { name: "characters", text: "单表快照" },
    ],
    agent: [
      { name: "{{tablesDigest}}", text: DIGEST_SUMMARY },
      { name: "{{systemDefaultPrompt}}", text: DEFAULT_PROMPT },
    ],
    ...overrides,
  };
}

describe("buildMacroOverviewRows（宏内容一览快照聚合）", () => {
  it("按序汇总全部宏：默认快照 → 视图 → 聊天宏 → 内置(full/表) → Agent 预设宏", () => {
    const rows = buildMacroOverviewRows(input());
    expect(rows.map((row) => row.name)).toEqual([
      "{{ste}}",
      "{{ste::人物}}",
      "{{ste::地点}}",
      "{{ste::本话}}",
      "{{ste::full}}",
      "{{ste::characters}}",
      "{{tablesDigest}}",
      "{{systemDefaultPrompt}}",
    ]);
  });

  it("文本 = 快照实际值（原样透传，空也透传——展示层负责「（空）」）", () => {
    const rows = buildMacroOverviewRows(input());
    expect(rows.find((row) => row.name === "{{ste}}")?.text).toBe(DIGEST_SUMMARY);
    expect(rows.find((row) => row.name === "{{ste::人物}}")?.text).toBe("人物快照");
    expect(rows.find((row) => row.name === "{{ste::地点}}")?.text).toBe("");
    expect(rows.find((row) => row.name === "{{tablesDigest}}")?.text).toBe(DIGEST_SUMMARY);
    expect(rows.find((row) => row.name === "{{systemDefaultPrompt}}")?.text).toBe(DEFAULT_PROMPT);
  });

  it("前缀为空（宏未注册）：记忆宏家族整体不列，Agent 预设宏仍列出", () => {
    const rows = buildMacroOverviewRows(input({ prefix: "" }));
    expect(rows.map((row) => row.name)).toEqual(["{{tablesDigest}}", "{{systemDefaultPrompt}}"]);
  });

  it("无视图/无聊天宏/无内置宏：对应分区不产生行（不报错）", () => {
    const rows = buildMacroOverviewRows(input({ views: [], chatScopeMacros: [], builtin: [] }));
    expect(rows.map((row) => row.name)).toEqual([
      "{{ste}}",
      "{{tablesDigest}}",
      "{{systemDefaultPrompt}}",
    ]);
  });
});
