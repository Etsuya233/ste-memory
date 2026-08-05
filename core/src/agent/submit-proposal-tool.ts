import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  MemoryEvidence,
  MemoryMessageRange,
  MemoryProposalError,
  MemoryProposalOperation,
  MemoryProposalPreview,
  MemoryProposalSubmission,
} from "../memory/index.ts";
import { memoryProposalBatch, memoryProposalSubmission } from "../memory/index.ts";
import type { MemorySpaceTableDigest } from "./digest.ts";
import { compileProposalOperations } from "./proposal-compiler.ts";
import { ProposalToolError } from "./proposal-tool-error.ts";
import type { ProposalState } from "./proposal-state.ts";

export const SUBMIT_PROPOSAL_TOOL_NAME = "submit_proposal";

const submitProposalParamsSchema = Type.Object({});

export interface SubmitProposalToolResult {
  readonly status: "submitted";
  readonly proposal: MemoryProposalSubmission;
}

export interface SubmitProposalToolDependencies {
  readonly digest: MemorySpaceTableDigest;
  readonly state: ProposalState;
  /** 完整校验（与 proposal_preview 同一套），提交前自动重跑做最终复核。 */
  readonly validateOperations: (
    operations: readonly MemoryProposalOperation[],
  ) => Promise<readonly MemoryProposalError[]>;
  readonly preview: (
    operations: readonly MemoryProposalOperation[],
  ) => Promise<MemoryProposalPreview>;
  /** 外部注入的处理块消息范围（模型不感知来源）。 */
  readonly messageRange: MemoryMessageRange;
  /** 外部注入的处理块整批证据（提交时由应用层附加）。 */
  readonly evidence: readonly MemoryEvidence[];
}

/**
 * submit_proposal：唯一完成信号。
 * 先自动重跑完整校验做最终复核，失败 throw 回喂（模型修正后再次提交）；
 * 成功则冻结提案（含统一 MutationBatch）并锁定 State，本阶段不持久化。
 */
export function createSubmitProposalTool(
  deps: SubmitProposalToolDependencies,
): AgentTool<typeof submitProposalParamsSchema, SubmitProposalToolResult> {
  return {
    name: SUBMIT_PROPOSAL_TOOL_NAME,
    label: "提交提案",
    description: SUBMIT_PROPOSAL_TOOL_DESCRIPTION,
    parameters: submitProposalParamsSchema,
    async execute(_toolCallId) {
      const result = await executeSubmitProposal(deps);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

const SUBMIT_PROPOSAL_TOOL_DESCRIPTION = [
  "提交当前提案（唯一完成信号）。提交前会自动重跑 proposal_preview 的全部校验；",
  "校验失败会报错（附全部失败原因），请修正后再次提交。",
  "提交成功后提案即冻结，不能再修改；请直接结束对话，不要继续调用任何工具。",
  "若确认无需任何变更，不要调用本工具，直接结束对话即可。",
].join("\n");

async function executeSubmitProposal(
  deps: SubmitProposalToolDependencies,
): Promise<SubmitProposalToolResult> {
  if (deps.state.submitted) {
    throw new ProposalToolError("提案已提交并冻结，请直接结束对话，不要重复提交");
  }
  const operations = compileProposalOperations(deps.digest, deps.state);
  if (operations.length === 0) {
    throw new ProposalToolError(
      "提案为空：没有任何变更操作。若确认无需变更，请直接结束对话（不要调用 submit_proposal）。",
    );
  }
  const errors = await deps.validateOperations(operations);
  if (errors.length > 0) {
    throw new ProposalToolError(
      [
        "提案校验未通过，未提交。失败原因：",
        ...errors.map((error) => `- ${error.externalId ?? "（整批）"}：${error.message}`),
        "请用 drop_mutate 移除或 mutate 修正对应操作，再次 proposal_preview 确认后重新提交。",
      ].join("\n"),
    );
  }
  const preview = await deps.preview(operations);
  const proposal = memoryProposalSubmission(
    deps.messageRange,
    deps.evidence,
    preview.operations,
    memoryProposalBatch(operations),
  );
  deps.state.markSubmitted(proposal);
  return { status: "submitted", proposal };
}
