import type { MemoryFieldValue, MemoryProposalSubmission } from "../memory/index.ts";

/** 会话内提案操作（key 级，模型视角）：mutate 累加/覆盖到 State，编译时映射为 id 级。 */
export interface ProposalStateOperation {
  readonly mutationId: string;
  readonly op: "create" | "update" | "delete";
  readonly tableKey: string;
  readonly tempId?: string;
  readonly recordId?: string;
  readonly expectedRevisionId?: string;
  readonly patch: Readonly<Record<string, MemoryFieldValue>>;
}

/** apply 入参：与 StateOperation 同构但无 mutationId（由 State 分配）。 */
export type ProposalStateOperationInput = Omit<ProposalStateOperation, "mutationId">;

export interface ProposalStateApplyResult {
  readonly mutationId: string;
  readonly replaced: boolean;
  readonly summary: string;
}

export interface ProposalStateDropResult {
  readonly dropped: string;
  readonly remaining: number;
  readonly summary: string;
}

/**
 * 提案会话 State（每 run 一个实例）：
 * - mutationId（M1/M2…）与 tempId（tmp:n）由引擎分配；
 * - 同表同标识（create 按 tempId、update/delete 按 recordId）重复操作直接覆盖，
 *   mutationId 保持不变（drop 依然有效），跨 op 也覆盖（delete 后 update = 取消删除）；
 * - submit 成功后锁定，任何修改/预览/重复提交都会被拒绝。
 */
export class ProposalState {
  #operations: ProposalStateOperation[] = [];
  #mutationCounter = 0;
  #tempCounter = 0;
  #submitted = false;
  #frozenProposal: MemoryProposalSubmission | undefined;

  get operations(): readonly ProposalStateOperation[] {
    return this.#operations;
  }

  get submitted(): boolean {
    return this.#submitted;
  }

  /** submit 冻结的提案（Agent run 结束时由宿主提取）。 */
  get frozenProposal(): MemoryProposalSubmission | undefined {
    return this.#frozenProposal;
  }

  /** 分配新临时 ID（create 不传 tempId 时由引擎分配）。 */
  allocateTempId(): string {
    return `tmp:${++this.#tempCounter}`;
  }

  /** 批次内全部 create 的 tempId。 */
  createTempIds(): ReadonlySet<string> {
    return new Set(
      this.#operations
        .filter((operation) => operation.op === "create")
        .map((operation) => operation.tempId!),
    );
  }

  /** 按 tempId 查找已有 create 操作（覆盖路径校验用）。 */
  findByTempId(tempId: string): ProposalStateOperation | undefined {
    return this.#operations.find(
      (operation) => operation.op === "create" && operation.tempId === tempId,
    );
  }

  /** 累加或覆盖一个操作；覆盖时 mutationId 保持不变并返回 replaced 提示。 */
  apply(input: ProposalStateOperationInput): ProposalStateApplyResult {
    this.#assertMutable();
    const identityKey = identityOf(input);
    const index = this.#operations.findIndex((operation) => identityOf(operation) === identityKey);
    if (index >= 0) {
      const existing = this.#operations[index]!;
      this.#operations[index] = { ...input, mutationId: existing.mutationId };
      return {
        mutationId: existing.mutationId,
        replaced: true,
        summary: summarize(input),
      };
    }
    const mutationId = `M${++this.#mutationCounter}`;
    this.#operations.push({ ...input, mutationId });
    return { mutationId, replaced: false, summary: summarize(input) };
  }

  /** 移除一个操作；mutationId 不存在返回 undefined（由工具转 throw 回喂）。 */
  drop(mutationId: string): ProposalStateDropResult | undefined {
    this.#assertMutable();
    const index = this.#operations.findIndex((operation) => operation.mutationId === mutationId);
    if (index < 0) return undefined;
    const [removed] = this.#operations.splice(index, 1);
    return {
      dropped: removed!.mutationId,
      remaining: this.#operations.length,
      summary: `dropped ${removed!.mutationId}（${summarize(removed!)}）`,
    };
  }

  /** submit 成功后锁定 State 并冻结提案。 */
  markSubmitted(proposal: MemoryProposalSubmission): void {
    this.#submitted = true;
    this.#frozenProposal = proposal;
  }

  #assertMutable(): void {
    if (this.#submitted) {
      throw new Error("提案已提交并冻结，不能再修改；请直接结束对话");
    }
  }
}

/** 同表同标识判定：create 按 tempId（批次内全局唯一），update/delete 按 recordId。 */
function identityOf(
  operation: Pick<ProposalStateOperation, "op" | "tableKey" | "tempId" | "recordId">,
): string {
  return operation.op === "create"
    ? `create:${operation.tempId}`
    : `${operation.tableKey}:${operation.recordId}`;
}

function summarize(operation: ProposalStateOperationInput): string {
  switch (operation.op) {
    case "create":
      return `create ${operation.tableKey} ${operation.tempId}`;
    case "update":
      return `update ${operation.tableKey} ${operation.recordId}`;
    case "delete":
      return `delete ${operation.tableKey} ${operation.recordId}`;
  }
}
