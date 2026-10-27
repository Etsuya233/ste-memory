import type { MacroSemanticOptions } from "../memory/index.ts";

export const MAX_RERANK_CANDIDATES = 200;
export const MAX_SEMANTIC_SCOPE = 10000;

/** SQL and Query share strict options; scope is a set, field/group order remains meaningful. */
export function parseSemanticOptions(raw: unknown): MacroSemanticOptions | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("语义选项必须为 JSON 对象");
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (!["rerank", "candidateLimit", "textFields", "scopeRecordIds"].includes(key))
      throw new Error(`未知语义选项：${key}`);
  if (value.rerank !== undefined && typeof value.rerank !== "boolean")
    throw new Error("rerank 必须为布尔值");
  if (
    value.candidateLimit !== undefined &&
    (!Number.isSafeInteger(value.candidateLimit) ||
      (value.candidateLimit as number) < 1 ||
      (value.candidateLimit as number) > MAX_RERANK_CANDIDATES)
  )
    throw new Error(`candidateLimit 须为 1–${MAX_RERANK_CANDIDATES} 的整数`);
  for (const key of ["textFields", "scopeRecordIds"] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim()))
      throw new Error(`${key} 必须为非空字符串组成的数组`);
    if (key === "textFields" && (!list.length || new Set(list).size !== list.length))
      throw new Error("textFields 须为非空且不重复的字段 Key 数组");
    if (key === "scopeRecordIds" && list.length > MAX_SEMANTIC_SCOPE)
      throw new Error(`scopeRecordIds 最多 ${MAX_SEMANTIC_SCOPE} 项`);
  }
  return {
    ...(value.rerank === undefined ? {} : { rerank: value.rerank as boolean }),
    ...(value.candidateLimit === undefined
      ? {}
      : { candidateLimit: value.candidateLimit as number }),
    ...(value.textFields === undefined ? {} : { textFields: [...(value.textFields as string[])] }),
    ...(value.scopeRecordIds === undefined
      ? {}
      : {
          scopeRecordIds: [...new Set(value.scopeRecordIds as string[])].sort(),
        }),
  };
}
