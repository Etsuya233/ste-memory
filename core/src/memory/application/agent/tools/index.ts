/**
 * Agent 工具包：工具定义与 Agent 解耦（ADR 0019）。
 *
 * 工具工厂只依赖端口（reader / ports / 校验闭包）与共享状态（digest、ProposalState），
 * 不感知 Agent 类；QueryAgent / ProposalAgent 只是工具清单 + prompt 组合器的薄装配。
 * 按域分子目录：query/（只读查询）、proposal/（提案变更管线）。
 */
export {
  QUERY_RECORDS_TOOL_NAME,
  QueryRecordsToolError,
  createQueryRecordsTool,
} from "./query/query-records-tool.ts";
export type {
  QueryRecordsToolDependencies,
  QueryRecordsToolParams,
  QueryRecordsToolResult,
  QueryRecordsToolResultRecord,
} from "./query/query-records-tool.ts";
export { ProposalState } from "./proposal/proposal-state.ts";
export type {
  ProposalStateApplyResult,
  ProposalStateDropResult,
  ProposalStateOperation,
  ProposalStateOperationInput,
} from "./proposal/proposal-state.ts";
export {
  compileProposalOperation,
  compileProposalOperations,
} from "./proposal/proposal-compiler.ts";
export { ProposalToolError } from "./proposal/proposal-tool-error.ts";
export { MUTATE_TOOL_NAME, createMutateTool } from "./proposal/mutate-tool.ts";
export type {
  MutateToolDependencies,
  MutateToolParams,
  MutateToolResult,
} from "./proposal/mutate-tool.ts";
export {
  PROPOSAL_PREVIEW_TOOL_NAME,
  createProposalPreviewTool,
} from "./proposal/proposal-preview-tool.ts";
export type {
  ProposalPreviewToolDependencies,
  ProposalPreviewToolParams,
  ProposalPreviewToolResult,
} from "./proposal/proposal-preview-tool.ts";
export { DROP_MUTATE_TOOL_NAME, createDropMutateTool } from "./proposal/drop-mutate-tool.ts";
export type {
  DropMutateToolDependencies,
  DropMutateToolParams,
  DropMutateToolResult,
} from "./proposal/drop-mutate-tool.ts";
export {
  SUBMIT_PROPOSAL_TOOL_NAME,
  createSubmitProposalTool,
} from "./proposal/submit-proposal-tool.ts";
export type {
  SubmitProposalToolDependencies,
  SubmitProposalToolResult,
} from "./proposal/submit-proposal-tool.ts";
