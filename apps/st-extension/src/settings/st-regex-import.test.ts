/**
 * ST 正则条目导入转换（ticket 22 / ADR 0011）：ST Regex 脚本对象 → 清洗规则，
 * 按替换串语义映射（"" → 去掉；$1/{{match}}/$0 → 保留；其余 → 替换），
 * placement 过滤 + /pat/flags 包裹解析 + 非 JS flags 丢弃，差异以 notes 说明。
 */
import { describe, expect, it } from "vitest";
import { convertStRegexScripts, type StRegexImportItem } from "./st-regex-import.ts";

let idCounter = 0;
function createId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

function script(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "uuid-1",
    scriptName: "去粗体",
    findRegex: "\\*\\*(.+?)\\*\\*",
    replaceString: "",
    trimStrings: [],
    placement: [1, 2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: NaN,
    maxDepth: NaN,
    ...overrides,
  };
}

function rulesOf(items: readonly StRegexImportItem[]) {
  return items.filter((item) => item.kind === "rule").map((item) => item.rule);
}

describe("convertStRegexScripts（载荷形态）", () => {
  it("数组逐条转换；单对象按一条处理；非对象 → 单条跳过", () => {
    const fromArray = convertStRegexScripts([script(), script({ scriptName: "第二条" })], createId);
    expect(fromArray).toHaveLength(2);
    expect(rulesOf(fromArray).map((r) => r.name)).toEqual(["去粗体", "第二条"]);

    const fromSingle = convertStRegexScripts(script(), createId);
    expect(rulesOf(fromSingle).map((r) => r.name)).toEqual(["去粗体"]);

    const fromJunk = convertStRegexScripts("junk", createId);
    expect(fromJunk).toEqual([
      { kind: "skipped", scriptName: "", reason: "导入内容不是正则条目数据（应为对象或对象数组）" },
    ]);
  });

  it("数组中非对象条目跳过，其余照常转换", () => {
    const items = convertStRegexScripts([script(), 42, null, script({ scriptName: "好条目" })], createId);
    expect(rulesOf(items).map((r) => r.name)).toEqual(["去粗体", "好条目"]);
    expect(items.filter((i) => i.kind === "skipped")).toHaveLength(2);
  });
});

describe("替换串 → 模式映射", () => {
  it('replaceString "" → 去掉；disabled → enabled 取反', () => {
    const [rule] = rulesOf(convertStRegexScripts([script({ replaceString: "" })], createId));
    expect(rule).toMatchObject({ name: "去粗体", mode: "discard", pattern: "\\*\\*(.+?)\\*\\*", flags: "g", enabled: true });
    const [disabled] = rulesOf(convertStRegexScripts([script({ replaceString: "", disabled: true })], createId));
    expect(disabled?.enabled).toBe(false);
  });

  it('"$1" / "{{match}}"（大小写不敏感） / "$0" → 替换模式，与 ST 的 JS 替换语义逐字一致（保留匹配间文本）', () => {
    const cases: readonly [replaceString: string, replacement: string][] = [
      ["$1", "$1"],
      ["{{match}}", "$0"],
      ["{{MATCH}}", "$0"],
      ["$0", "$0"],
    ];
    for (const [replaceString, replacement] of cases) {
      const [rule] = rulesOf(convertStRegexScripts([script({ replaceString })], createId));
      expect(rule).toMatchObject({ mode: "replace", replacement });
    }
  });

  it("其余替换串 → 替换模式，{{match}} 展开为 $0，$1/$<name> 原样保留", () => {
    const [rule] = rulesOf(
      convertStRegexScripts([script({ replaceString: "「{{match}}」已由 $1 与 $<name> 取代" })], createId),
    );
    expect(rule).toMatchObject({
      mode: "replace",
      replacement: "「$0」已由 $1 与 $<name> 取代",
    });
  });
});

describe("findRegex / flags 解析", () => {
  it("未包裹 → 默认 g；/pattern/flags 包裹 → 拆出 flags（空 flags 同样默认 g）", () => {
    const [plain] = rulesOf(convertStRegexScripts([script({ findRegex: "abc" })], createId));
    expect(plain).toMatchObject({ pattern: "abc", flags: "g" });
    const [wrapped] = rulesOf(convertStRegexScripts([script({ findRegex: "/abc/gi" })], createId));
    expect(wrapped).toMatchObject({ pattern: "abc", flags: "gi" });
    const [wrappedEmpty] = rulesOf(convertStRegexScripts([script({ findRegex: "/abc/" })], createId));
    expect(wrappedEmpty).toMatchObject({ pattern: "abc", flags: "g" });
  });

  it("包裹内可含转义斜杠；非 JS flags（x/X/A/J/U）丢弃并给 note", () => {
    const [escaped] = rulesOf(convertStRegexScripts([script({ findRegex: "/a\\/b/" })], createId));
    expect(escaped?.pattern).toBe("a\\/b");
    const [dropped] = convertStRegexScripts([script({ findRegex: "/abc/gx" })], createId);
    expect(dropped?.kind).toBe("rule");
    if (dropped !== undefined && dropped.kind === "rule") {
      expect(dropped.rule.flags).toBe("g");
      expect(dropped.notes).toContain("匹配式包含 JS 不支持的 flags（x），已忽略");
    }
  });
});

describe("placement 过滤与跳过原因", () => {
  it("placement 与 {用户输入(1), AI 输出(2)} 无交集 → 跳过", () => {
    for (const placement of [[], [0], [3], [5, 6], [0, 3]]) {
      const [item] = convertStRegexScripts([script({ placement })], createId);
      expect(item?.kind).toBe("skipped");
      if (item !== undefined && item.kind === "skipped") {
        expect(item.reason).toContain("作用范围");
      }
    }
  });

  it("缺脚本名 / 缺匹配式 / 名称超长 / 正则无法编译 → 跳过并说明原因", () => {
    const noName = convertStRegexScripts([script({ scriptName: "" })], createId);
    expect(noName[0]).toMatchObject({ kind: "skipped", reason: expect.stringContaining("脚本名称") });
    const noRegex = convertStRegexScripts([script({ findRegex: "" })], createId);
    expect(noRegex[0]).toMatchObject({ kind: "skipped", reason: expect.stringContaining("匹配式") });
    const longName = convertStRegexScripts([script({ scriptName: "x".repeat(121) })], createId);
    expect(longName[0]).toMatchObject({ kind: "skipped", reason: expect.stringContaining("120") });
    const badRegex = convertStRegexScripts([script({ findRegex: "(" })], createId);
    expect(badRegex[0]).toMatchObject({ kind: "skipped", reason: expect.stringContaining("无法编译") });
  });
});

describe("ST 专属字段差异说明（notes）", () => {
  it("trimStrings / 宏替换 / 运行上下文字段各自给 note，不影响转换", () => {
    const [item] = convertStRegexScripts(
      [
        script({
          replaceString: "$1",
          trimStrings: ["—", "〜"],
          substituteRegex: 2,
          markdownOnly: true,
          runOnEdit: true,
          minDepth: 1,
          maxDepth: 5,
        }),
      ],
      createId,
    );
    expect(item?.kind).toBe("rule");
    if (item !== undefined && item.kind === "rule") {
      expect(item.notes).toEqual(
        expect.arrayContaining([
          "trimStrings（2 项）未迁移",
          "宏替换未迁移（substituteRegex=2），匹配式按原文使用",
          "ST 运行上下文字段（markdownOnly/runOnEdit/minDepth/maxDepth）未迁移",
        ]),
      );
      expect(item.rule.mode).toBe("replace");
    }
  });

  it("干净的全局条目无 notes", () => {
    const [item] = convertStRegexScripts([script()], createId);
    expect(item?.kind).toBe("rule");
    if (item !== undefined && item.kind === "rule") expect(item.notes).toEqual([]);
  });
});
