import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  MemoryFieldValue,
  MemoryProposalError,
  MemoryProposalOperation,
} from "../memory/index.ts";
import { MEMORY_PROPOSAL_TEMP_ID_PREFIX, isProposalTempId } from "../memory/index.ts";
import {
  availableFieldKeys,
  availableTableKeys,
  findFieldInDigest,
  findTableInDigest,
  type MemorySpaceTableDigest,
  type MemoryTableDigest,
} from "./digest.ts";
import { compileProposalOperation } from "./proposal-compiler.ts";
import { ProposalToolError } from "./proposal-tool-error.ts";
import type { ProposalState, ProposalStateOperationInput } from "./proposal-state.ts";

export const MUTATE_TOOL_NAME = "mutate";

// ---------------------------------------------------------------------------
// 参数 Schema（TypeBox）：op 为判别字段，形状错误由 pi 在 execute 前拦截
// ---------------------------------------------------------------------------

const fieldValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
  Type.Array(Type.String()),
]);

const patchSchema = Type.Record(Type.String(), fieldValueSchema);

const mutateParamsSchema = Type.Union([
  Type.Object({
    op: Type.Literal("create"),
    table: Type.String(),
    patch: patchSchema,
    tempId: Type.Optional(Type.String()),
  }),
  Type.Object({
    op: Type.Literal("update"),
    table: Type.String(),
    recordId: Type.String(),
    expectedRevisionId: Type.String(),
    patch: patchSchema,
  }),
  Type.Object({
    op: Type.Literal("delete"),
    table: Type.String(),
    recordId: Type.String(),
    expectedRevisionId: Type.String(),
  }),
]);

export type MutateToolParams = Static<typeof mutateParamsSchema>;

export interface MutateToolResult {
  readonly mutationId: string;
  /** 仅 create：新分配或覆盖目标的临时 ID。 */
  readonly tempId?: string;
  /** 本次是否覆盖了同表同标识的旧操作（mutationId 保持不变）。 */
  readonly replaced: boolean;
  readonly summary: string;
}

export interface MutateToolDependencies {
  readonly digest: MemorySpaceTableDigest;
  /** 会话内提案 State（每 run 一个实例）。 */
  readonly state: ProposalState;
  /** 单操作领域校验（表/字段/类型/必填/选项/目标存在性），由 ProposalAgent 装配。 */
  readonly validateOperation: (
    operation: MemoryProposalOperation,
  ) => Promise<readonly MemoryProposalError[]>;
}

/**
 * mutate：累加/覆盖单个操作到 State。
 * 即时校验不过关 throw 回喂（错误信息带可用 key 列表，模型可自愈）；
 * 不查 revision、不做跨操作检查（proposal_preview 负责）。
 */
export function createMutateTool(
  deps: MutateToolDependencies,
): AgentTool<typeof mutateParamsSchema, MutateToolResult> {
  return {
    name: MUTATE_TOOL_NAME,
    label: "提交记录变更",
    description: MUTATE_TOOL_DESCRIPTION,
    parameters: mutateParamsSchema,
    async execute(_toolCallId, params) {
      const result = await executeMutate(deps, params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

const MUTATE_TOOL_DESCRIPTION = [
  "向提案累加或覆盖一个记录变更操作（不落库，提案提交前随时可改）。参数全部使用表/字段 key：",
  "- op：create 新建 / update 更新 / delete 删除，每次调用只处理一个操作。",
  "- create：{ table, patch, tempId? }。tempId 不传时由引擎分配（返回结果中给出，格式 tmp:n，",
  "  后续引用该记录或覆盖它时使用）；传已存在的 tempId 会覆盖对应 create 操作。",
  "- update：{ table, recordId, expectedRevisionId, patch }。patch 省略的字段保持不变，null 清空。",
  "- delete：{ table, recordId, expectedRevisionId }。",
  "- recordId 与 expectedRevisionId 取自 query_records 结果的 id 与 revisionId（update/delete 必填）。",
  "- 引用字段的值填目标记录 id，或本批次 create 返回的 tmp: 前缀临时 ID。",
  "- 同表同记录/同 tempId 的重复操作会直接覆盖旧操作（replaced 为 true，mutationId 不变）。",
  "- 目标记录不存在的 update/delete 会报错；需要新建请用 create（禁止按名称 upsert）。",
  "变更是否正确以 proposal_preview 的整批校验为准。",
].join("\n");

async function executeMutate(
  deps: MutateToolDependencies,
  params: MutateToolParams,
): Promise<MutateToolResult> {
  const table = findTableInDigest(deps.digest, params.table);
  if (!table) {
    throw new ProposalToolError(
      `表 key「${params.table}」不存在或未启用。可用表 key：${availableTableKeys(deps.digest)}。`,
    );
  }
  if (params.op !== "delete") {
    validatePatchKeys(table, params.patch);
  }

  const input = await buildStateOperationInput(deps, table.key, params);
  const compiled = compileProposalOperation(deps.digest, input);
  const errors = await deps.validateOperation(compiled);
  if (errors.length > 0) {
    throw new ProposalToolError(errors.map((error) => error.message).join("\n"));
  }

  const applied = deps.state.apply(input);
  return {
    mutationId: applied.mutationId,
    tempId: input.op === "create" ? input.tempId : undefined,
    replaced: applied.replaced,
    summary: applied.summary,
  };
}

async function buildStateOperationInput(
  deps: MutateToolDependencies,
  tableKey: string,
  params: MutateToolParams,
): Promise<ProposalStateOperationInput> {
  switch (params.op) {
    case "create": {
      const tempId = params.tempId ?? deps.state.allocateTempId();
      assertTempIdShape(tempId);
      if (params.tempId) {
        const existing = deps.state.findByTempId(tempId);
        if (existing && existing.tableKey !== tableKey) {
          throw new ProposalToolError(
            `临时 ID ${tempId} 已被表「${existing.tableKey}」的 create 使用，不能跨表复用`,
          );
        }
      }
      return { op: "create", tableKey, tempId, patch: params.patch };
    }
    case "update":
      return {
        op: "update",
        tableKey,
        recordId: params.recordId,
        expectedRevisionId: params.expectedRevisionId,
        patch: params.patch,
      };
    case "delete":
      return {
        op: "delete",
        tableKey,
        recordId: params.recordId,
        expectedRevisionId: params.expectedRevisionId,
        patch: {},
      };
  }
}

function assertTempIdShape(tempId: string): void {
  if (!isProposalTempId(tempId)) {
    throw new ProposalToolError(
      `tempId 必须以「${MEMORY_PROPOSAL_TEMP_ID_PREFIX}」开头：${tempId}。不传 tempId 时引擎会自动分配。`,
    );
  }
}

/** patch 字段 key 的 digest 校验：不存在/未启用立即报错并附可用 key 列表。 */
function validatePatchKeys(
  table: MemoryTableDigest,
  patch: Readonly<Record<string, MemoryFieldValue>>,
): void {
  for (const key of Object.keys(patch)) {
    if (!findFieldInDigest(table, key)) {
      throw new ProposalToolError(
        `字段 key「${key}」在表「${table.key}」中不存在或未启用。可用字段 key：${availableFieldKeys(table)}。`,
      );
    }
  }
}
