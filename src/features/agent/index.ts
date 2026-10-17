export type { LlmPort } from "./llm-port.ts";
export type { MemoryFieldDigest, MemorySpaceTableDigest, MemoryTableDigest } from "./digest.ts";
export {
  buildMemorySpaceTableDigest,
  findFieldInDigest,
  findTableInDigest,
  availableFieldKeys,
  availableTableKeys,
} from "./digest.ts";
export {
  PROPOSAL_AGENT_BASE_INSTRUCTIONS,
  composeInteractiveProposalAgentSystemPrompt,
  composeProposalAgentMessages,
  composeProposalAgentSystemPrompt,
  composeQueryAgentSystemPrompt,
  composeTableDigestSummary,
} from "./prompt-composer.ts";
export type {
  ComposedAgentMessage,
  ProposalMessagesComposer,
  ProposalSystemPromptComposer,
} from "./prompt-composer.ts";
export {
  QUERY_RECORDS_TOOL_NAME,
  QueryRecordsToolError,
  createQueryRecordsTool,
} from "./tools/index.ts";
export type {
  QueryRecordsToolDependencies,
  QueryRecordsToolParams,
  QueryRecordsToolResult,
  QueryRecordsToolResultRecord,
} from "./tools/index.ts";
export { DEFAULT_QUERY_AGENT_TIMEOUT_MS, QueryAgent } from "./query-agent.ts";
export type { QueryAgentOptions, QueryAgentRunHooks, QueryAgentRunInput } from "./query-agent.ts";
export {
  ProposalState,
  compileProposalOperation,
  compileProposalOperations,
  ProposalToolError,
  MUTATE_TOOL_NAME,
  createMutateTool,
  PROPOSAL_PREVIEW_TOOL_NAME,
  createProposalPreviewTool,
  DROP_MUTATE_TOOL_NAME,
  createDropMutateTool,
  SUBMIT_PROPOSAL_TOOL_NAME,
  createSubmitProposalTool,
} from "./tools/index.ts";
export type {
  ProposalStateApplyResult,
  ProposalStateDropResult,
  ProposalStateOperation,
  ProposalStateOperationInput,
  MutateToolDependencies,
  MutateToolParams,
  MutateToolResult,
  ProposalPreviewToolDependencies,
  ProposalPreviewToolParams,
  ProposalPreviewToolResult,
  DropMutateToolDependencies,
  DropMutateToolParams,
  DropMutateToolResult,
  SubmitProposalToolDependencies,
  SubmitProposalToolResult,
} from "./tools/index.ts";
// Agent 运行基础设施（ADR 0024）：调用方用工具工厂 + pi-agent-core Agent
// + 本组符号自行装配；插件侧的默认装配在 fill-agent-runner（runFillAgent）。
export {
  abortedAgentRunSummary,
  convertAgentMessagesToLlm,
  runAgentWithTimeout,
} from "./agent-run.ts";
export type { AgentRunSummary, RunHooks } from "./agent-run.ts";
