import type { MemorySpaceTableDigest } from "./digest.ts";

/**
 * 组合 QueryAgent 系统提示词：基础问答指令 + 启用表/字段摘要。
 * 摘要与 query_records 工具校验共用同一份 digest，模型可见范围 = 工具可用范围。
 * 不含来源消息（来源消息与提案提示词归 12）。
 */
export function composeQueryAgentSystemPrompt(digest: MemorySpaceTableDigest): string {
  return [
    "你是一个问答助手，回答用户关于记忆空间记录的问题。",
    "",
    "工作方式：",
    "1. 只使用工具 query_records（只读）查询记录，不要编造数据。",
    "2. 基于查询返回的真实记录回答；查不到时如实说明，并给出可进一步查询的建议。",
    "3. 一次查询内多个条件是 AND 语义；需要 OR 或更复杂的检索时，分多次查询后自行归纳。",
    "4. 用户问题不明确时，先用查询确认范围，再回答。",
    "",
    "可用表与字段（key 是 query_records 参数取值，只能使用下列 key；",
    "填错会报错，错误信息会附带可用 key 列表）：",
    ...digest.tables.flatMap((table) => tableLines(table)),
  ].join("\n");
}

function tableLines(table: MemorySpaceTableDigest["tables"][number]): string[] {
  const lines = [`【${table.key}｜${table.name}】`];
  if (table.description.length > 0) lines.push(`说明：${table.description}`);
  for (const field of table.fields)
    lines.push(`- ${field.key}｜${field.name}：${field.type}${fieldLineSuffix(field)}`);
  return lines;
}

function fieldLineSuffix(
  field: MemorySpaceTableDigest["tables"][number]["fields"][number],
): string {
  const parts: string[] = [];
  if (field.required) parts.push("必填");
  if (field.options.length > 0) parts.push(`选项：${field.options.join(" / ")}`);
  if (field.referenceTableKey) parts.push(`引用：${field.referenceTableKey}（值为记录 id）`);
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}
