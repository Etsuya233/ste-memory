import { API_URL, responseJson } from "./http.ts";
import type { SourceMessage } from "./memory-spaces.ts";

export const CLEANING_RULE_MODES = ["keep", "discard"] as const;
export type CleaningRuleMode = (typeof CLEANING_RULE_MODES)[number];

export const CLEANING_RULE_FLAGS = ["g", "i", "m", "s", "u", "y"] as const;

export interface CleaningRule {
  readonly id: string;
  readonly memorySpaceId: string;
  readonly position: number;
  readonly enabled: boolean;
  readonly name: string;
  readonly mode: CleaningRuleMode;
  readonly pattern: string;
  readonly flags: string;
}

export interface CleaningRuleInput {
  readonly name: string;
  readonly mode: CleaningRuleMode;
  readonly pattern: string;
  readonly flags: string;
  /** 创建时可选（默认 true），与服务端保持一致。 */
  readonly enabled?: boolean;
}

export async function listCleaningRules(memorySpaceId: string): Promise<CleaningRule[]> {
  return responseJson(await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/cleaning-rules`));
}

export async function createCleaningRule(
  memorySpaceId: string,
  input: CleaningRuleInput,
): Promise<CleaningRule> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/cleaning-rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateCleaningRule(
  memorySpaceId: string,
  ruleId: string,
  patch: Partial<CleaningRuleInput> & { readonly enabled?: boolean },
): Promise<CleaningRule> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/cleaning-rules/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteCleaningRule(memorySpaceId: string, ruleId: string): Promise<void> {
  const response = await fetch(
    `${API_URL}/memory-spaces/${memorySpaceId}/cleaning-rules/${ruleId}`,
    { method: "DELETE" },
  );
  if (!response.ok) await responseJson(response);
}

export async function reorderCleaningRules(
  memorySpaceId: string,
  ruleIds: readonly string[],
): Promise<CleaningRule[]> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/cleaning-rules/order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ruleIds }),
    }),
  );
}

/** 预览用原文消息（raw=1 跳过清洗规则，limit 限制条数）。 */
export async function loadRawMessages(
  memorySpaceId: string,
  limit: number,
): Promise<SourceMessage[]> {
  return responseJson(
    await fetch(`${API_URL}/memory-spaces/${memorySpaceId}/messages?raw=1&limit=${limit}`),
  );
}

/**
 * 清洗规则纯变换（前端预览复刻，语义与 API 侧 transform.ts 一致）：
 * 按顺序执行启用规则；保留 = 捕获组 1（若有）否则整段匹配的全局拼接，无匹配原样不动；
 * 去掉 = 删除所有匹配段；无 g flag 时只处理第一处。
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
  return matches.map((match) => cleaningCapture(match)).join("");
}

function cleaningCapture(match: RegExpMatchArray): string {
  const group = match[1];
  return group !== undefined ? group : match[0];
}

/** 校验单条规则（名称/模式/正则/flags）；返回错误消息（undefined 表示通过）。
 * 错误文案与 API 侧 validate.ts 保持一致，避免两端语义漂移。 */
export function validateCleaningRule(rule: {
  readonly name: string;
  readonly mode: CleaningRuleMode;
  readonly pattern: string;
  readonly flags: string;
}): string | undefined {
  if (rule.name.trim().length === 0) return "清洗规则名称不能为空";
  if (rule.name.length > 120) return "清洗规则名称不能超过 120 个字符";
  if (rule.pattern.length === 0) return "正则表达式不能为空";
  if (!/^[gimsuy]*$/u.test(rule.flags) || new Set(rule.flags).size !== rule.flags.length) {
    return "正则 flags 只能是 g/i/m/s/u/y 且不能重复";
  }
  try {
    new RegExp(rule.pattern, rule.flags);
  } catch {
    return "正则表达式语法错误";
  }
  return undefined;
}
