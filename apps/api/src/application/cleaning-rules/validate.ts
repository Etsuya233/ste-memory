import type { CleaningRuleInput } from "../ports/cleaning-rule.ts";

type Validated<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** 全量校验清洗规则输入（创建 / 合并后的更新）；返回错误消息（undefined 表示通过）。 */
export function validateCleaningRuleInput(
  input: CleaningRuleInput,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (typeof input.name !== "string" || input.name.trim().length === 0) {
    return { ok: false, message: "清洗规则名称不能为空" };
  }
  if (input.name.length > 120) {
    return { ok: false, message: "清洗规则名称不能超过 120 个字符" };
  }
  if (input.mode !== "keep" && input.mode !== "discard") {
    return { ok: false, message: "清洗规则模式必须是 keep 或 discard" };
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return { ok: false, message: "启用状态必须是布尔值" };
  }
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    return { ok: false, message: "正则表达式不能为空" };
  }
  if (
    typeof input.flags !== "string" ||
    !/^[gimsuy]*$/u.test(input.flags) ||
    new Set(input.flags).size !== input.flags.length
  ) {
    return { ok: false, message: "正则 flags 只能是 g/i/m/s/u/y 且不能重复" };
  }
  try {
    new RegExp(input.pattern, input.flags);
  } catch {
    return { ok: false, message: "正则表达式语法错误" };
  }
  return { ok: true };
}

/** 更新补丁的字段形态校验（不校验合并后的完整语义）。 */
export function validateCleaningRulePatchShape(
  patch: unknown,
): Validated<Partial<CleaningRuleInput> & { readonly enabled?: boolean }> {
  if (typeof patch !== "object" || patch === null) {
    return { ok: false, message: "清洗规则更新内容无效" };
  }
  const candidate = patch as Record<string, unknown>;
  const fields: readonly (keyof CleaningRuleInput)[] = ["name", "mode", "pattern", "flags"];
  if (!fields.some((field) => field in candidate) && !("enabled" in candidate)) {
    return { ok: false, message: "没有可更新的字段" };
  }
  if (candidate.name !== undefined && typeof candidate.name !== "string") {
    return { ok: false, message: "清洗规则名称必须是字符串" };
  }
  if (candidate.mode !== undefined && candidate.mode !== "keep" && candidate.mode !== "discard") {
    return { ok: false, message: "清洗规则模式必须是 keep 或 discard" };
  }
  if (candidate.pattern !== undefined && typeof candidate.pattern !== "string") {
    return { ok: false, message: "正则表达式必须是字符串" };
  }
  if (candidate.flags !== undefined && typeof candidate.flags !== "string") {
    return { ok: false, message: "正则 flags 必须是字符串" };
  }
  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
    return { ok: false, message: "启用状态必须是布尔值" };
  }
  return {
    ok: true,
    value: candidate as Partial<CleaningRuleInput> & { readonly enabled?: boolean },
  };
}
