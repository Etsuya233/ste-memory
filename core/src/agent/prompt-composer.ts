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
    ...digestSummaryLines(digest),
  ].join("\n");
}

/**
 * 组合 ProposalAgent 系统提示词：提案工作流指令 + 启用表/字段摘要。
 * 处理块消息内容由宿主放入本轮消息（模型只管看内容对表操作）。
 */
export function composeProposalAgentSystemPrompt(digest: MemorySpaceTableDigest): string {
  return [
    "你是记忆表格填写助手：根据本轮消息中的对话内容，把信息填写进记忆空间的表格。",
    "",
    "工作流程：",
    "1. 用 query_records 查询当前记录（只反映已提交数据；未提交变更请用 proposal_preview 查看）。",
    "2. 用 mutate 增量构建变更：一次一个操作（create 新建 / update 更新 / delete 删除）。",
    "3. 用 proposal_preview 做整批校验与差异预览，直到 valid 为 true。",
    "4. 用 drop_mutate 移除错误操作（按 mutationId），修正后重新预览。",
    "5. 确认无误后调用 submit_proposal 提交提案（唯一完成信号）；提交成功后直接结束对话。",
    "若确认无需任何变更，不要调用 submit_proposal，直接结束对话。",
    "",
    "规则：",
    "- update/delete 的 recordId 与 expectedRevisionId 取自 query_records 结果的 id 与 revisionId。",
    "- create 的临时 ID 由引擎分配（返回的 tempId，格式 tmp:n）；引用该记录或覆盖它时使用。",
    "- 引用字段的值填目标记录 id，或本批次 create 返回的 tmp: 前缀临时 ID。",
    "- 目标记录不存在的 update/delete 会报错；需要新建请用 create（禁止按名称 upsert）。",
    "- 同表同记录的重复操作会直接覆盖（replaced 为 true），留意 mutate 返回的提示。",
    "- 删除记录前先确认它没有被其他记录引用；被引用时先更新引用方或放弃删除。",
    "- 消息内容中提到的信息不要编造；查不到或无法确定时不要强行填写。",
    "",
    ...digestSummaryLines(digest),
  ].join("\n");
}

function digestSummaryLines(digest: MemorySpaceTableDigest): string[] {
  return [
    "可用表与字段（key 是工具参数取值，只能使用下列 key；",
    "填错会报错，错误信息会附带可用 key 列表）：",
    ...digest.tables.flatMap((table) => tableLines(table)),
  ];
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
