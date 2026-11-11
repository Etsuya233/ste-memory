import type { MemorySpaceBackup } from "../memory-snapshot/snapshot.ts";
import type {
  MemoryEvidenceRepository,
  MemoryProposalPorts,
  MemoryRecordService,
  MemorySpaceReader,
} from "../memory/index.ts";
import type { FillTask, FillTaskBatchResult } from "./fill-task.ts";

/** 独占空间的批次连接；普通读取继续使用最近已提交快照。 */
export interface CommittedFillBatch {
  readonly chatKey: string;
  readonly snapshot?: MemorySpaceBackup;
  readonly newFloors: readonly number[];
}

export type SavedFillBatch = CommittedFillBatch & { readonly snapshot: MemorySpaceBackup };

export interface FillTaskSession {
  readonly reader: MemorySpaceReader;
  readonly ports: MemoryProposalPorts;
  readonly evidence: MemoryEvidenceRepository;
  /** 每次调用在当前批次事务内的 SAVEPOINT 中执行，不发布正式数据。 */
  readonly recordWriter: Pick<MemoryRecordService, "commitProposal">;
  /** 将记忆与本批已处理楼层一起提交，随后请求宿主保存。 */
  commitAndSave(batch: FillTaskBatchResult): Promise<CommittedFillBatch | void>;
  /** 回滚记忆修改；非取消失败的楼层在释放 writer 前提交 error 进度。 */
  rollback(failedFloors?: readonly number[]): Promise<void>;
  /** 保存或回滚结束后释放空间写入许可。 */
  release(): Promise<void>;
}

export type BeginFillTaskSession = (
  task: FillTask,
  signal: AbortSignal,
) => Promise<FillTaskSession>;
