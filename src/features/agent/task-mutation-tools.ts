import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  memoryProposalBatch,
  memoryProposalSubmission,
  validateProposalOperation,
  type MemoryEvidence,
  type MemoryMessageRange,
  type MemoryProposalPorts,
  type MemoryRecordService,
  type MemorySpaceId,
} from "../memory/index.ts";
import type { MemorySpaceTableDigest } from "./digest.ts";
import { createMutateTool } from "./tools/proposal/mutate-tool.ts";
import { ProposalState } from "./tools/proposal/proposal-state.ts";
import { compileProposalOperations } from "./tools/proposal/proposal-compiler.ts";

interface TaskMutationToolsInput {
  readonly digest: MemorySpaceTableDigest;
  readonly ports: MemoryProposalPorts;
  readonly memorySpaceId: MemorySpaceId;
  readonly messageRange: MemoryMessageRange;
  readonly evidence: readonly MemoryEvidence[];
  readonly writer: Pick<MemoryRecordService, "commitProposal">;
  readonly signal?: AbortSignal;
}

/** 事务模式每次调用立即写入；交互提案工具保留原有确认边界。 */
export function createTaskMutationTools(input: TaskMutationToolsInput): {
  readonly tools: AgentTool[];
  assertCompleted(): void;
} {
  let finished = false;
  let changed = false;
  const assertOpen = () => {
    input.signal?.throwIfAborted();
    if (finished) throw new Error("本块填写已完成，请结束对话");
  };
  const template = createMutateTool({
    digest: input.digest,
    state: new ProposalState(),
    validateOperation: (operation) =>
      validateProposalOperation(input.ports, input.memorySpaceId, operation),
  });
  const mutate: AgentTool<typeof template.parameters, unknown> = {
    ...template,
    description:
      "立即在本任务事务中 create/update/delete 一条记录。参数使用表和字段 key。create 提供 table 和 patch，禁止指定 tempId，返回真实 recordId。update/delete 提供 query_records 中最新的 recordId 和 expectedRevisionId；update 同时提供 patch。成功后 query_records 可读取变更，引用使用真实 recordId。约束失败仅撤销当前调用，可修正重试。",
    async execute(id, params) {
      assertOpen();
      if (params.tempId !== undefined)
        throw new Error("事务模式不接受 tempId，请使用返回的真实 recordId");
      const state = new ProposalState();
      const tool = createMutateTool({
        digest: input.digest,
        state,
        validateOperation: (operation) =>
          validateProposalOperation(input.ports, input.memorySpaceId, operation),
      });
      await tool.execute(id, params);
      const operations = compileProposalOperations(input.digest, state);
      const proposal = memoryProposalSubmission(
        input.messageRange,
        input.evidence,
        [],
        memoryProposalBatch(operations),
      );
      assertOpen();
      const result = await input.writer.commitProposal(input.memorySpaceId, proposal, "agent");
      changed = true;
      const operation = operations[0]!;
      const recordId =
        operation.type === "create"
          ? (await input.ports.records.list(input.memorySpaceId, operation.tableId)).find(
              (record) => record.revisionId === result.revisionId,
            )!.id
          : operation.recordId;
      const details = { status: "applied", recordId, revisionId: result.revisionId };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  };
  const tools: AgentTool[] = [
    mutate,
    {
      name: "submit_proposal",
      label: "完成本块填写",
      description:
        "确认本块修改完成。变更已暂存在任务事务中；整个填表任务成功后由宿主统一提交。调用后直接结束对话。",
      parameters: Type.Object({}),
      executionMode: "sequential",
      async execute() {
        assertOpen();
        finished = true;
        return {
          content: [{ type: "text", text: "本块填写完成" }],
          details: { status: "submitted" },
        };
      },
    },
  ];
  return {
    tools,
    assertCompleted() {
      if (changed && !finished) throw new Error("Agent 已修改记录但未确认本块完成，本次任务已撤销");
    },
  };
}
