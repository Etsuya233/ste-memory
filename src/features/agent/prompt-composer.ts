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
  "- 只查询与本块消息内容相关的表；仅为执行表格填写规则（如累计纪要总结）时可查询相关历史。查询时先用条件缩小范围，只投影需要的字段。",
  "- create 的临时 ID 由引擎分配（返回的 tempId，格式 tmp:n）；引用该记录或覆盖它时使用。",
  "- 引用字段的值填目标记录 id，或本批次 create 返回的 tmp: 前缀临时 ID。",
  "- 目标记录不存在的 update/delete 会报错；需要新建请用 create（禁止按名称 upsert）。",
  "- 同记录连续 update 合并 patch，不同字段累计，同字段后写覆盖，null 清空；create 重写与跨 op 替换旧操作。",
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
 * 组合记忆助手系统提示词：查询记忆并准备提案，
 * 提案由用户通过界面确认提交，后台填表任务沿用自动提交。
 * 不注入消息范围/证据框架——用户的对话指令就是本轮任务。
 */
export function composeInteractiveProposalAgentSystemPrompt(
  digest: MemorySpaceTableDigest,
): string {
  return [
    "你是记忆助手：通过查询记忆表格回答问题，也可按用户要求准备记录变更。普通提问只查询，不创建提案。",
    "",
    "工作流程：",
    "1. 用 query_records 查询当前记录（只反映已提交数据；未提交变更请用 proposal_preview 查看）。",
    "2. 用 mutate 增量构建变更：一次一个操作（create 新建 / update 更新 / delete 删除）。",
    "3. 用 proposal_preview 做整批校验与差异预览，直到 valid 为 true。",
    "4. 用 drop_mutate 移除错误操作（按 mutationId），修正后重新预览。",
    "5. 修改准备完成后调用 submit_proposal，向用户说明具体增删改，提示在界面查看差异并点击确认提交。",
    "6. submit_proposal 只准备确认，不会写入数据库。用户通过界面确认后宿主才提交；聊天中的同意不能代替确认按钮。准备后直接结束回答。",
    "用户不同意、或确认无需任何变更时，不要调用 submit_proposal，直接结束对话。",
    "",
    "规则：",
    "- update/delete 的 recordId 与 expectedRevisionId 取自 query_records 结果的 id 与 revisionId。",
    "- 只查询与当前指令相关的表；查询先用条件缩小范围，只投影需要的字段，不要全表拉取。",
    "- create 的临时 ID 由引擎分配（返回的 tempId，格式 tmp:n）；引用该记录或覆盖它时使用。",
    "- 引用字段的值填目标记录 id，或本批次 create 返回的 tmp: 前缀临时 ID。",
    "- 目标记录不存在的 update/delete 会报错；需要新建请用 create（禁止按名称 upsert）。",
    "- 同记录连续 update 合并 patch，不同字段累计，同字段后写覆盖，null 清空；create 重写与跨 op 替换旧操作。",
    "- 删除记录前先确认它没有被其他记录引用；被引用时先更新引用方或放弃删除。",
    "- 变更内容要基于用户的指令与查询到的真实记录，不要编造；无法确定时先询问用户。",
    "",
    ...digestSummaryLines(digest),
  ].join("\n");
}

function digestSummaryLines(digest: MemorySpaceTableDigest, includePrompts = true): string[] {
  return [
    ...(includePrompts && digest.prompt ? [`通用填写规则：\n${digest.prompt}`, ""] : []),
    "可用表与字段（key 是工具参数取值，只能使用下列 key；",
    "填错会报错，错误信息会附带可用 key 列表）：",
    ...digest.tables.flatMap((table) => tableLines(table, includePrompts)),
  ];
}

function tableLines(
  table: MemorySpaceTableDigest["tables"][number],
  includePrompts: boolean,
): string[] {
  const lines = [`【${table.key}｜${table.name}】`];
  if (includePrompts && table.prompt) lines.push(`填写规则：${table.prompt}`);
  if (table.description.length > 0) lines.push(`说明：${table.description}`);
  for (const field of table.fields)
    lines.push(
      `- ${field.key}｜${field.name}：${field.type}${fieldLineSuffix(field, includePrompts)}`,
    );
  return lines;
}

function fieldLineSuffix(
  field: MemorySpaceTableDigest["tables"][number]["fields"][number],
  includePrompts: boolean,
): string {
  const parts: string[] = [];
  if (includePrompts && field.prompt) parts.push(field.prompt);
  if (field.required) parts.push("必填");
  if (field.maxChars != null) parts.push(`≤${field.maxChars}字`);
  if (field.valuePatternMessage != null) parts.push(`格式：${field.valuePatternMessage}`);
  if (field.options.length > 0) parts.push(`选项：${field.options.join(" / ")}`);
  if (field.referenceTableKey) parts.push(`引用：${field.referenceTableKey}（值为记录 id）`);
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}
