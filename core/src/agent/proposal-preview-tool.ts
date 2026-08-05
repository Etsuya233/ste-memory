import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  MemoryProposalError,
  MemoryProposalOperation,
  MemoryProposalPreview,
  MemoryProposalPreviewOperation,
} from "../memory/index.ts";
import { availableTableKeys, findTableInDigest, type MemorySpaceTableDigest } from "./digest.ts";
import { compileProposalOperations } from "./proposal-compiler.ts";
import { ProposalToolError } from "./proposal-tool-error.ts";
import type { ProposalState } from "./proposal-state.ts";

export const PROPOSAL_PREVIEW_TOOL_NAME = "proposal_preview";

const proposalPreviewParamsSchema = Type.Object({
  table: Type.Optional(Type.String()),
});

export type ProposalPreviewToolParams = Static<typeof proposalPreviewParamsSchema>;

export interface ProposalPreviewToolResult {
  /** 整批一致性校验是否通过；false 时 errors 列出全部失败原因（模型据此修正）。 */
  readonly valid: boolean;
  readonly tables: readonly string[];
  readonly operations: readonly MemoryProposalPreviewOperation[];
  readonly errors: readonly ProposalPreviewError[];
}

export interface ProposalPreviewError {
  readonly mutationId: string | undefined;
  readonly message: string;
}

export interface ProposalPreviewToolDependencies {
  readonly digest: MemorySpaceTableDigest;
  readonly state: ProposalState;
  /** 完整校验（单操作 + 跨操作一致性，查库），由 ProposalAgent 装配。 */
  readonly validateOperations: (
    operations: readonly MemoryProposalOperation[],
  ) => Promise<readonly MemoryProposalError[]>;
  /** 差异预览（只读，无副作用）。 */
  readonly preview: (
    operations: readonly MemoryProposalOperation[],
  ) => Promise<MemoryProposalPreview>;
}

/**
 * proposal_preview：整批一致性校验 + 差异预览。
 * 业务校验失败是正常返回（valid:false + errors），不 throw；只读，不落库。
 */
export function createProposalPreviewTool(
  deps: ProposalPreviewToolDependencies,
): AgentTool<typeof proposalPreviewParamsSchema, ProposalPreviewToolResult> {
  return {
    name: PROPOSAL_PREVIEW_TOOL_NAME,
    label: "校验并预览提案",
    description: PROPOSAL_PREVIEW_TOOL_DESCRIPTION,
    parameters: proposalPreviewParamsSchema,
    async execute(_toolCallId, params) {
      const result = await executeProposalPreview(deps, params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

const PROPOSAL_PREVIEW_TOOL_DESCRIPTION = [
  "对当前提案做整批一致性校验并生成差异预览（只读，不落库，可反复调用）。",
  "- 校验内容：字段值/必填/选项、目标记录存在、期望修订匹配、引用目标存在、",
  "  删除安全（被删记录不得仍被引用）、临时 ID 解析。",
  "- 返回 valid 与 errors（按 mutationId 定位失败操作，message 为失败原因）；",
  "  operations 为预览展开（create 全新增、update 字段变更、delete 原样），display 为提交后显示文本。",
  "- 可选参数 table：只预览该表的操作。",
  "- valid 为 false 时请用 drop_mutate 移除或 mutate 修正对应操作后再次预览。",
  "- query_records 只反映已提交数据；未提交变更请以此工具为准。",
].join("\n");

async function executeProposalPreview(
  deps: ProposalPreviewToolDependencies,
  params: ProposalPreviewToolParams,
): Promise<ProposalPreviewToolResult> {
  if (deps.state.submitted) {
    throw new ProposalToolError("提案已提交并冻结，不能再预览；请直接结束对话");
  }
  if (params.table && !findTableInDigest(deps.digest, params.table)) {
    throw new ProposalToolError(
      `表 key「${params.table}」不存在或未启用。可用表 key：${availableTableKeys(deps.digest)}。`,
    );
  }
  const operations = compileProposalOperations(deps.digest, deps.state);
  const errors = await deps.validateOperations(operations);
  const preview = await deps.preview(operations);
  if (params.table) {
    const tableKeyByMutationId = new Map(
      deps.state.operations.map((operation) => [operation.mutationId, operation.tableKey]),
    );
    const filterTable = (mutationId: string | undefined) =>
      !mutationId || tableKeyByMutationId.get(mutationId) === params.table;
    return {
      valid: errors.length === 0,
      tables: preview.tables,
      operations: preview.operations.filter((operation) => operation.tableKey === params.table),
      errors: errors
        .filter((error) => filterTable(error.externalId))
        .map((error) => ({ mutationId: error.externalId, message: error.message })),
    };
  }
  return {
    valid: errors.length === 0,
    tables: preview.tables,
    operations: preview.operations,
    errors: errors.map((error) => ({ mutationId: error.externalId, message: error.message })),
  };
}
