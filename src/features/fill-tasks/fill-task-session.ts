import type {
  MemoryEvidenceRepository,
  MemoryProposalPorts,
  MemoryRecordService,
  MemorySpaceReader,
} from "../memory/index.ts";
import type { FillTask } from "./fill-task.ts";

/** 独占空间的任务连接；普通读取继续使用最近已提交快照。 */
export interface FillTaskSession {
  readonly reader: MemorySpaceReader;
  readonly ports: MemoryProposalPorts;
  readonly evidence: MemoryEvidenceRepository;
  /** 每次调用在任务事务内的 SAVEPOINT 中执行，不发布正式数据。 */
  readonly recordWriter: Pick<MemoryRecordService, "commitProposal">;
  /** 提交整个任务、发布读取快照，并调用持久化保存。 */
  commitAndSave(): Promise<void>;
  rollback(): Promise<void>;
  /** 保存或回滚结束后释放空间写入许可。 */
  release(): Promise<void>;
}

export type BeginFillTaskSession = (
  task: FillTask,
  signal: AbortSignal,
) => Promise<FillTaskSession>;
