import { describe, expect, it } from "vitest";
import type { MemoryTable } from "../../features/memory/index.ts";
import { TRUNCATION_MARKER } from "../../features/macros/memory-context-snapshot.ts";
import {
  builtinMacroNames,
  defaultMacroToken,
  macroBudgetInfo,
  macroConflictBadges,
  macroNameStatus,
  macroOutputInfo,
  macroOutputLabel,
  macroRowMeta,
  macroToken,
} from "./macro-ui-model.ts";

function table(key: string, enabled = true): MemoryTable {
  return {
    id: `table-${key}` as MemoryTable["id"],
    memorySpaceId: "space-1" as MemoryTable["memorySpaceId"],
    key: key as MemoryTable["key"],
    position: 0,
    name: key,
    description: "",
    prompt: "",
    displayStrategy: null,
    enabled,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("macroNameStatus / 宏表达式", () => {
  it("带花括号与裸名都合法，解析为裸注册名", () => {
    expect(macroNameStatus("ste")).toEqual({ kind: "valid", registrationName: "ste" });
    expect(macroNameStatus("{{ste}}")).toEqual({ kind: "valid", registrationName: "ste" });
    expect(macroNameStatus("  {{ my-memory_2 }}  ")).toEqual({
      kind: "valid",
      registrationName: "my-memory_2",
    });
  });

  it("空值/非法值分开（界面文案据此区分「未配置」与「填错了」）", () => {
    expect(macroNameStatus("")).toEqual({ kind: "empty" });
    expect(macroNameStatus("   ")).toEqual({ kind: "empty" });
    expect(macroNameStatus("{{记忆}}")).toEqual({ kind: "invalid" });
    expect(macroNameStatus("2memory")).toEqual({ kind: "invalid" });
  });

  it("表达式只在有合法宏名时生成", () => {
    expect(defaultMacroToken("ste")).toBe("{{ste}}");
    expect(defaultMacroToken("")).toBe("");
    expect(macroToken("ste", "未完成伏笔")).toBe("{{ste::未完成伏笔}}");
    expect(macroToken("", "未完成伏笔")).toBe("");
  });
});

describe("输出状态与预算", () => {
  it("空/正常/截断状态与字数", () => {
    expect(macroOutputInfo("")).toEqual({ characters: 0, empty: true, truncated: false });
    expect(macroOutputInfo("abc")).toEqual({ characters: 3, empty: false, truncated: false });
    expect(macroOutputInfo(`abc${TRUNCATION_MARKER}`).truncated).toBe(true);
    expect(macroOutputLabel("")).toBe("空输出");
    expect(macroOutputLabel("abc")).toBe("3 字");
    expect(macroOutputLabel(`abc${TRUNCATION_MARKER}`)).toBe(
      `已截断 · ${`abc${TRUNCATION_MARKER}`.length} 字`,
    );
  });

  it("预算只统计记忆宏家族（默认/全局宏/对话宏/内置），不含 Agent 宏", () => {
    const budget = macroBudgetInfo(
      [
        { name: "{{ste}}", text: "abc" },
        { name: "{{ste::伏笔}}", text: `hello${TRUNCATION_MARKER}` },
        { name: "{{ste::full}}", text: "full" },
        { name: "{{tablesDigest}}", text: "agent" },
      ],
      "{{ste}}",
    );
    expect(budget).toEqual({ defaultCharacters: 3, truncatedCount: 1, macroCount: 3 });
  });

  it("宏名非法/为空时没有预算", () => {
    expect(macroBudgetInfo([{ name: "{{ste}}", text: "abc" }], "")).toBeUndefined();
    expect(macroBudgetInfo([{ name: "{{ste}}", text: "abc" }], "{{记忆}}")).toBeUndefined();
  });
});

describe("内置名与同名覆盖提示", () => {
  it("内置名 = full + 当前空间启用表 Key", () => {
    expect([...builtinMacroNames([table("people"), table("places", false)])].sort()).toEqual([
      "full",
      "people",
    ]);
  });

  it("全局宏被同名对话宏覆盖，或覆盖同名内置宏", () => {
    expect(
      macroConflictBadges({
        scope: "global",
        name: "伏笔",
        chatNames: new Set(["伏笔"]),
        builtinNames: new Set(["full"]),
      })[0]?.text,
    ).toBe("对话宏优先");
    expect(
      macroConflictBadges({
        scope: "global",
        name: "people",
        builtinNames: new Set(["full", "people"]),
      })[0]?.text,
    ).toBe("覆盖内置");
  });

  it("对话宏覆盖同名全局/内置宏", () => {
    const badges = macroConflictBadges({
      scope: "chat",
      name: "people",
      globalNames: new Set(["people"]),
      builtinNames: new Set(["full", "people"]),
    });
    expect(badges.map((badge) => badge.text)).toEqual(["覆盖全局", "覆盖内置"]);
  });
});

describe("列表行摘要", () => {
  it("输出体积置于最前 + 表名 + 选择条件；无活动空间时不显示输出", () => {
    expect(
      macroRowMeta({
        tableName: "角色档案",
        selectionSummary: "状态 ∈ 埋设中",
        outputText: "abc",
        hasActiveSpace: true,
      }),
    ).toBe("3 字 · 角色档案 · 状态 ∈ 埋设中");
    expect(
      macroRowMeta({
        tableName: "角色档案",
        selectionSummary: "",
        outputText: "",
        hasActiveSpace: false,
      }),
    ).toBe("角色档案");
  });
});
