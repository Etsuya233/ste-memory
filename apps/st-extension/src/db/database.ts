import { Dexie, type Table } from "dexie";
import type {
  MemoryEvidenceId,
  MemoryEvidenceReference,
  MemoryEvidenceSnapshot,
  MemoryField,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemorySpace,
  MemorySpaceId,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type { FillTask, FloorFillStatus } from "../fill-tasks/fill-task.ts";
import type { LogEntry } from "../logging/log.ts";

/**
 * 证据条目的存储形态：领域 evidence_id 映射为主键 id（Dexie 行主键路径为 id），
 * 外加记忆空间作用域。领域类型本身不含空间字段（参照实现以 memory_space_id 列
 * 承载），Dexie 行必须携带它才能支撑跨空间隔离查询、来源唯一索引与空间删除级联。
 */
export type MemoryEvidenceRow = (
  Omit<MemoryEvidenceSnapshot, "evidence_id"> | Omit<MemoryEvidenceReference, "evidence_id">
) & {
  readonly id: MemoryEvidenceId;
  readonly memorySpaceId: MemorySpaceId;
};

/** 插件 Dexie 数据库默认名称（同一 origin 下与后续版本共用，ADR 0002） */
export const ST_MEMORY_DB_NAME = "ste-memory";

/**
 * v1 schema：记忆空间 / 记忆表格 / 字段定义。
 *
 * - 实体按领域对象原样存储：IndexedDB 原生支持数组与对象，不需要像 SQLite
 *   参照实现那样把 options / displayStrategy JSON 字符串化——导出与云同步
 *   （ticket 07/08）直接序列化行即可。
 * - 复合唯一索引在数据库层兜底 core 的「定义 Key 空间内唯一」规则：
 *   - memoryTables: `[memorySpaceId+key]`（空间内表格 Key 唯一）
 *   - memoryFields: `[memorySpaceId+tableId+key]`（表内字段 Key 唯一）
 * - 跨空间隔离：所有查询都携带 memorySpaceId 作用域，走复合索引/索引过滤。
 * - 字段类型创建后不可变等规则由 core 服务层强制（repository 只做读写）。
 */

/**
 * v2 schema：记忆记录 / 修订历史 / 字段证据。
 *
 * - memoryRecords：当前记录，payload / fieldEvidence / source 原样存储；
 *   修订身份（revisionId）随行保存，repository 的 commit 用它做乐观锁。
 * - memoryRecordHistory：修订批次归档的旧状态快照，recordId 归属 + archivedAt
 *   排序供历史查询（与 SQLite 参照实现的过滤/排序语义一致）。
 * - memoryEvidence：证据条目独立存储，`&[memorySpaceId+source_type+source_id]`
 *   唯一索引在数据库层兜底「同一来源身份只存一条证据」（与参照实现的
 *   UNIQUE(memory_space_id, source_type, source_id_json) 同语义；不同点：
 *   参照实现把 source_id JSON 字符串化，数字 7 与字符串 "7" 会互相冲突，
 *   Dexie 存原始值按类型区分——更精确，且领域类型本就区分二者）。
 *   注意索引键路径用领域对象的属性名（source_type / source_id，蛇形），
 *   与 memorySpaceId 包装字段同为行上的真实属性。
 * - 记录/历史/证据在空间删除时级联清理、记录/历史在表格删除时级联清理，
 *   由 repository 删除实现保证（与参照实现 ON DELETE CASCADE 同语义）。
 */

/**
 * v3 schema：填表任务 + 楼层进度台账（ticket 13）。
 *
 * - memoryFillTasks：填表任务行（runId 主键；[memorySpaceId+createdAt] 供
 *   触发 UI 的「最近任务」查询，memorySpaceId 索引供活动任务守卫）。
 * - floorFillLedger：楼层进度台账，按（记忆空间, 同步楼层）唯一记录
 *   processed / error（untracked = 无行）；id = `${memorySpaceId}:${floor}`。
 *   空间删除时由 repository 删除实现级联清理（与参照实现同语义）。
 *
 * v4 schema：通用日志（ADR 0008）。
 *
 * - memoryLogs：本地审计日志，++id 自增主键（插入顺序即时间顺序，修剪删最旧）；
 *   [type+createdAt] / [key+createdAt] / [spaceId+createdAt] 供时间倒序过滤查询；
 *   level 不建索引（1000 条上限内内存过滤可接受）。纯本地：云同步指纹只统计
 *   记忆表、备份/镜像序列化不含本表；空间删除时由 repository 级联清理。
 */
export class SteMemoryDatabase extends Dexie {
  memorySpaces!: Table<MemorySpace, MemorySpaceId>;
  memoryTables!: Table<MemoryTable, MemoryTableId>;
  memoryFields!: Table<MemoryField, MemoryFieldId>;
  memoryRecords!: Table<MemoryRecord, MemoryRecordId>;
  memoryRecordHistory!: Table<MemoryRecordHistory, MemoryRecordHistoryId>;
  memoryEvidence!: Table<MemoryEvidenceRow, MemoryEvidenceId>;
  memoryFillTasks!: Table<FillTask, string>;
  floorFillLedger!: Table<FloorLedgerRow, string>;
  memoryLogs!: Table<LogEntry, number>;

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
