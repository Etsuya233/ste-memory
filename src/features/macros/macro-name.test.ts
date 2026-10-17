import { describe, expect, it } from "vitest";
import { resolveMacroRegistrationName } from "./macro-name.ts";

/**
 * 宏名解析（ticket 15）：设置值 → ST 注册名。契约 = ST 标识符规则
 * （/^[a-zA-Z][\w-_]*$/，字母开头，大小写不敏感查找）；支持带花括号（默认
 * 建议形态，可整段粘贴）与裸名两种写法；非法/为空 = undefined（不注册无注入）。
 */
describe("resolveMacroRegistrationName", () => {
  it("带花括号默认形态：剥壳返回裸标识符", () => {
    expect(resolveMacroRegistrationName("{{memoryContext}}")).toBe("memoryContext");
  });

  it("裸名直接返回", () => {
    expect(resolveMacroRegistrationName("memoryContext")).toBe("memoryContext");
  });

  it("花括号内允许空白；首尾空白容忍（ST register 内部同样 trim）", () => {
    expect(resolveMacroRegistrationName("  {{ memoryContext }}  ")).toBe("memoryContext");
    expect(resolveMacroRegistrationName("  memoryContext  ")).toBe("memoryContext");
  });

  it("标识符规则：字母开头 + 字母数字下划线连字符（ST MACRO_IDENTIFIER_PATTERN 同源）", () => {
    expect(resolveMacroRegistrationName("{{my-memory_2}}")).toBe("my-memory_2");
    expect(resolveMacroRegistrationName("{{_memory}}")).toBeUndefined(); // 下划线开头非法
    expect(resolveMacroRegistrationName("{{2memory}}")).toBeUndefined(); // 数字开头非法
  });

  it("非法字符（空格/中文/花括号内嵌）→ undefined", () => {
    expect(resolveMacroRegistrationName("{{memory Context}}")).toBeUndefined();
    expect(resolveMacroRegistrationName("{{记忆}}")).toBeUndefined();
    expect(resolveMacroRegistrationName("{{x}}y")).toBeUndefined(); // 花括号未完整包裹
    expect(resolveMacroRegistrationName("x{{y}}")).toBeUndefined();
  });

  it("空值 → undefined（不放置宏则无注入）", () => {
    expect(resolveMacroRegistrationName("")).toBeUndefined();
    expect(resolveMacroRegistrationName("  ")).toBeUndefined();
    expect(resolveMacroRegistrationName("{{}}")).toBeUndefined();
    expect(resolveMacroRegistrationName("{{  }}")).toBeUndefined();
  });
});
