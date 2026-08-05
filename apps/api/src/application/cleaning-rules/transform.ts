import type { CleaningRule } from "../ports/cleaning-rule.ts";

/**
 * 清洗规则纯变换（ADR apps/0001：读取时应用，原文永不改写）。
 *
 * 语义（用户确认）：
 * - 按传入顺序执行（调用方保证已按 position 升序排列——仓库端 ORDER BY position，
 *   web 草稿按数组顺序），只应用启用的规则；上一条的输出是下一条的输入；
 * - 保留 = 有匹配则内容替换为「捕获组 1（若有）否则整段匹配」的全局拼接；
 *   无匹配则原样不动；
 * - 去掉 = 删除所有匹配段；无匹配同样原样不动；
 * - flags 不含 g 时（允许取消勾选）：保留只取第一处匹配，去掉只删第一处；
 * - 能匹配空串的正则允许保存（JS 引擎对零长匹配自动推进 lastIndex，不会死循环）。
 */
export function applyCleaningRules(content: string, rules: readonly CleaningRule[]): string {
  let result = content;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    result = applyCleaningRule(result, rule);
  }
  return result;
}

export function applyCleaningRule(content: string, rule: CleaningRule): string {
  const regex = new RegExp(rule.pattern, rule.flags);
  if (rule.mode === "discard") {
    return content.replace(regex, "");
  }
  const matches: readonly RegExpMatchArray[] = regex.global
    ? [...content.matchAll(regex)]
    : (() => {
        const match = content.match(regex);
        return match ? [match] : [];
      })();
  if (matches.length === 0) return content;
  const captures: string[] = [];
  for (const match of matches) captures.push(cleaningCapture(match));
  return captures.join("");
}

/** 有捕获组 1 时输出捕获组 1（即使捕获到空串），否则输出整段匹配。 */
function cleaningCapture(match: RegExpMatchArray): string {
  const group = match[1];
  return group !== undefined ? group : match[0];
}
