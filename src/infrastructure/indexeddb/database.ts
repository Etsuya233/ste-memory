import type { MemorySpaceId } from "../../features/memory/index.ts";
import { Dexie, type Table } from "dexie";
import type { AssistantSession } from "../../features/query-chat/session-store.ts";
import type { FillTask, FloorFillStatus } from "../../features/fill-tasks/fill-task.ts";
import type {
  RecordVector,
  VectorSuppression,
  VectorTask,
} from "../../features/vector-index/types.ts";

export const ST_MEMORY_DB_NAME = "ste-memory";

/** IndexedDB只管理任务、台账、向量与助手会话，废弃空间内容不读取、不迁移。 */
export class SteMemoryDatabase extends Dexie {
  assistantSessions!: Table<AssistantSession, string>;
  memoryFillTasks!: Table<FillTask, string>;
  floorFillLedger!: Table<FloorLedgerRow, string>;
  vectorTasks!: Table<VectorTask, string>;
  recordVectors!: Table<RecordVector, string>;
  vectorSuppressions!: Table<VectorSuppression, string>;

  constructor(name: string = ST_MEMORY_DB_NAME) {
    super(name);
    this.version(1).stores({
      memorySpaces: "id",
      memoryTables: "id, &[memorySpaceId+key], memorySpaceId",
      memoryFields: "id, &[memorySpaceId+tableId+key], [memorySpaceId+tableId]",
    });
    this.version(2).stores({
      memoryRecords: "id, [memorySpaceId+tableId], memorySpaceId",
      memoryRecordHistory:
        "id, [memorySpaceId+tableId+recordId], [memorySpaceId+recordId], memorySpaceId",
      memoryEvidence: "id, &[memorySpaceId+source_type+source_id], memorySpaceId",
    });
    this.version(3).stores({
      memoryFillTasks: "runId, [memorySpaceId+createdAt], memorySpaceId",
      floorFillLedger: "id, &[memorySpaceId+floor], memorySpaceId",
    });
    this.version(4).stores({
      memoryLogs: "++id, [type+createdAt], [key+createdAt], [spaceId+createdAt]",
    });
    this.version(5).stores({});
    this.version(6).stores({
      vectorTasks:
        "id, memorySpaceId, [memorySpaceId+tableId], [memorySpaceId+tableId+recordId], [status+createdAt]",
      recordVectors: "id, memorySpaceId, [memorySpaceId+tableId], [memorySpaceId+tableId+recordId]",
      vectorSuppressions: "id, memorySpaceId",
    });
    this.version(7).stores({});
    this.version(8).stores({});
    this.version(9).stores({ assistantSessions: "id, spaceId, [chatKey+spaceId], updatedAt" });
    this.version(10)
      .stores({})
      .upgrade(async (transaction) => {
        await transaction
          .table("assistantSessions")
          .toCollection()
          .modify((session) => {
            session.storageRevision = 0;
          });
      });
    this.version(11).stores({});
    this.version(12).stores({
      memorySpaces: null,
      memoryTables: null,
      memoryFields: null,
      memoryRecords: null,
      memoryRecordHistory: null,
      memoryEvidence: null,
    });
  }
}

/** 楼层进度台账行：floor 与领域楼层号同值，状态只存非 untracked。 */
export interface FloorLedgerRow {
  readonly id: string;
  readonly memorySpaceId: MemorySpaceId;
  readonly floor: number;
  readonly status: Exclude<FloorFillStatus, "untracked">;
  readonly updatedAt: string;
}
