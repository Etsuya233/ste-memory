/**
 * 宏名解析（纯函数）：把用户配置的宏名（设置面板值，默认「{{memoryContext}}」，
 * 用户可直接粘贴进提示词预设）解析为 ST 注册名（不带花括号的裸标识符）。
 *
 * ST 宏引擎事实（release 1.18.0 源码已核实）：macros.register(name, { handler })
 * 的 name 是裸标识符，标识符规则 /^[a-zA-Z][\w-_]*$/（字母开头，后接字母数字
 * 下划线连字符），查找大小写不敏感；同名注册覆盖并警告。注册名只在本模块解析，
 * 宿主薄层直接调用 ST API。
 */

/** ST 宏标识符规则（public/scripts/macros/engine/MacroLexer.js MACRO_IDENTIFIER_PATTERN 同源） */
const ST_MACRO_IDENTIFIER_PATTERN = /^[a-zA-Z][A-Za-z0-9_-]*$/;

/**
 * 把设置值解析为可注册的宏名；非法/为空返回 undefined（宿主不注册 = 无注入）。
 * 支持两种写法：带花括号的「{{memoryContext}}」（默认建议形态，可整段粘贴）与
 * 裸名「memoryContext」；花括号必须完整包裹（「{{x}}y」非法）。空白容忍
 * （ST 内部 register 也会 trim）。
 */
export function resolveMacroRegistrationName(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{{")) {
    if (!trimmed.endsWith("}}")) return undefined;
    const inner = trimmed.slice(2, -2).trim();
    return ST_MACRO_IDENTIFIER_PATTERN.test(inner) ? inner : undefined;
  }
  return ST_MACRO_IDENTIFIER_PATTERN.test(trimmed) ? trimmed : undefined;
}
