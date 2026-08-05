import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { ProposalToolError } from "./proposal-tool-error.ts";
import type { ProposalState } from "./proposal-state.ts";

export const DROP_MUTATE_TOOL_NAME = "drop_mutate";

const dropMutateParamsSchema = Type.Object({
  mutationId: Type.String(),
});

export type DropMutateToolParams = Static<typeof dropMutateParamsSchema>;

export interface DropMutateToolResult {
  readonly dropped: string;
  /** State 剩余操作数。 */
  readonly remaining: number;
  readonly summary: string;
}

export interface DropMutateToolDependencies {
  readonly state: ProposalState;
}

/**
 * drop_mutate：从 State 移除一个操作（按 mutate 返回的 mutationId）。
 * mutationId 不存在 throw 回喂（附当前操作列表）；悬空引用由下次 proposal_preview 报出。
 */
export function createDropMutateTool(
  deps: DropMutateToolDependencies,
): AgentTool<typeof dropMutateParamsSchema, DropMutateToolResult> {
  return {
    name: DROP_MUTATE_TOOL_NAME,
    label: "移除变更操作",
    description: DROP_MUTATE_TOOL_DESCRIPTION,
    parameters: dropMutateParamsSchema,
    async execute(_toolCallId, params) {
      const result = executeDropMutate(deps, params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

const DROP_MUTATE_TOOL_DESCRIPTION = [
  "从当前提案中移除一个操作（按 mutate 返回的 mutationId，如 M1）。",
  "- 移除 create 后，引用其 tempId 的操作会变成悬空引用，由下次 proposal_preview 报出。",
  "- mutationId 不存在会报错并附带当前操作列表。",
].join("\n");

function executeDropMutate(
  deps: DropMutateToolDependencies,
  params: DropMutateToolParams,
): DropMutateToolResult {
  const dropped = deps.state.drop(params.mutationId);
  if (!dropped) {
    const current = deps.state.operations
      .map((operation) => `${operation.mutationId}（${operation.op} ${operation.tableKey}）`)
      .join("、");
    throw new ProposalToolError(
      `mutationId「${params.mutationId}」不存在。当前操作：${current || "（无）"}。`,
    );
  }
  return {
    dropped: dropped.dropped,
    remaining: dropped.remaining,
    summary: dropped.summary,
  };
}
