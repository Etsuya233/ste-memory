import type { MemorySpaceTableDigest } from "./digest.ts";

/** 提案类 Agent 的系统提示词组合器（后台填表 / 交互式填写共用签名）。 */
export type ProposalSystemPromptComposer = (digest: MemorySpaceTableDigest) => string;

/**
 * 编排消息（消息组合器输出）：role 决定去向——system 合并进系统提示词（每次请求
 * 都置于最前，pi 的消息类型无 system 角色，系统提示词只经 AgentState.systemPrompt），
 * user / assistant 进入对话前缀（run 的本轮消息之前）。
 */
export interface ComposedAgentMessage {
  readonly role: "system" | "user" | "assistant";
  readonly text: string;
}

/**
 * 提案类 Agent 的消息组合器：digest → 编排消息列表（消息和消息的组合，取代
 * 单一 system prompt 字符串）。宿主编排时用它注入用户/助手消息；缺省 = 单条
 * system 消息（等价于系统默认组合器）。
 */
export type ProposalMessagesComposer = (
  digest: MemorySpaceTableDigest,
) => readonly ComposedAgentMessage[];

/**
 * 组合默认的提案 Agent 编排消息：单条 system 消息（内容 = 系统默认提示词全文）。
 * 与 composeProposalAgentSystemPrompt 等价，供需要消息形态组合器的宿主使用。
 */
export function composeProposalAgentMessages(
  digest: MemorySpaceTableDigest,
): readonly ComposedAgentMessage[] {
  return [{ role: "system", text: composeProposalAgentSystemPrompt(digest) }];
}

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
    "5. 查询先窄后宽：先用 conditions 与 fields 投影缩小范围，结果不足再放宽，不要一次性全表查询。",
    "",
    ...digestSummaryLines(digest),
  ].join("\n");
}

/**
 * 组合 ProposalAgent 系统提示词：提案工作流指令 + 启用表/字段摘要。
 * 处理块消息内容由宿主放入本轮消息（模型只管看内容对表操作）。
 */
export function composeProposalAgentSystemPrompt(digest: MemorySpaceTableDigest): string {
  return [PROPOSAL_AGENT_BASE_INSTRUCTIONS, composeTableDigestSummary(digest)].join("\n\n");
}

/**
 * 提案 Agent 基础指令（不含表/字段摘要）：Agent 提示词预设（st-extension ADR 0006）
 * 的「复制为自定义」与 {{systemDefaultPrompt}} 展开共用，避免指令文本在插件侧复制。
 */
export const PROPOSAL_AGENT_BASE_INSTRUCTIONS = [
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
  "- 只查询与本块消息内容相关的表；块消息未提及的主题不要预查。查询时先用条件缩小范围，只投影需要的字段。",
  "- create 的临时 ID 由引擎分配（返回的 tempId，格式 tmp:n）；引用该记录或覆盖它时使用。",
  "- 引用字段的值填目标记录 id，或本批次 create 返回的 tmp: 前缀临时 ID。",
  "- 目标记录不存在的 update/delete 会报错；需要新建请用 create（禁止按名称 upsert）。",
  "- 同表同记录的重复操作会直接覆盖（replaced 为 true），留意 mutate 返回的提示。",
  "- 删除记录前先确认它没有被其他记录引用；被引用时先更新引用方或放弃删除。",
  "- 消息内容中提到的信息不要编造；查不到或无法确定时不要强行填写。",
].join("\n");

/**
 * 表/字段摘要文本（composeProposalAgentSystemPrompt 的摘要部分）：Agent 提示词预设的
 * {{tablesDigest}} 占位符展开与此共用同一格式（ADR 0006）——摘要格式是工具可用性契约，
 * 不在插件侧复制实现。
 */
export function composeTableDigestSummary(digest: MemorySpaceTableDigest): string {
  return digestSummaryLines(digest).join("\n");
}

/**
 * 组合交互式填写（ADR 0019）系统提示词：边栏聊天中执行记忆记录变更，
 * 提交前必须征得用户明确同意（prompt 软闸门），与后台填表任务的自动提交相对。
 * 不注入消息范围/证据框架——用户的对话指令就是本轮任务。
 */
export function composeInteractiveProposalAgentSystemPrompt(
  digest: MemorySpaceTableDigest,
): string {
  return [
    "你是记忆空间的填写助手：理解用户的指令，把记忆记录变更整理成提案并提交。",
    "",
    "工作流程：",
    "1. 用 query_records 查询当前记录（只反映已提交数据；未提交变更请用 proposal_preview 查看）。",
    "2. 用 mutate 增量构建变更：一次一个操作（create 新建 / update 更新 / delete 删除）。",
    "3. 用 proposal_preview 做整批校验与差异预览，直到 valid 为 true。",
    "4. 用 drop_mutate 移除错误操作（按 mutationId），修正后重新预览。",
    "5. 调用 submit_proposal 之前，必须先用一句话向用户陈述将执行的变更（哪些记录的增删改），并明确询问用户是否同意。",
    "6. 只有用户明确同意后，才允许调用 submit_proposal（唯一完成信号）；提交成功后直接结束对话。",
    "用户不同意、或确认无需任何变更时，不要调用 submit_proposal，直接结束对话。",
    "",
    "规则：",
    "- update/delete 的 recordId 与 expectedRevisionId 取自 query_records 结果的 id 与 revisionId。",
    "- 只查询与当前指令相关的表；查询先用条件缩小范围，只投影需要的字段，不要全表拉取。",
    "- create 的临时 ID 由引擎分配（返回的 tempId，格式 tmp:n）；引用该记录或覆盖它时使用。",
    "- 引用字段的值填目标记录 id，或本批次 create 返回的 tmp: 前缀临时 ID。",
    "- 目标记录不存在的 update/delete 会报错；需要新建请用 create（禁止按名称 upsert）。",
    "- 同表同记录的重复操作会直接覆盖（replaced 为 true），留意 mutate 返回的提示。",
    "- 删除记录前先确认它没有被其他记录引用；被引用时先更新引用方或放弃删除。",
    "- 变更内容要基于用户的指令与查询到的真实记录，不要编造；无法确定时先询问用户。",
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
  if (field.maxChars != null) parts.push(`≤${field.maxChars}字`);
  if (field.valuePatternMessage != null) parts.push(`格式：${field.valuePatternMessage}`);
  if (field.options.length > 0) parts.push(`选项：${field.options.join(" / ")}`);
  if (field.referenceTableKey) parts.push(`引用：${field.referenceTableKey}（值为记录 id）`);
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}
