import "fake-indexeddb/auto";
import {
  MemoryFieldService,
  MemoryRecordService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryEvidenceId,
  type MemoryFieldId,
  type MemoryRecordHistoryId,
  type MemoryRecordId,
  type MemoryRevisionId,
  type MemorySpaceId,
  type MemoryTableId,
} from "../../features/memory/index.ts";
import { TablePresetApplyService } from "../../features/table-presets/table-preset-apply-service.ts";
import { SYSTEM_TABLE_PRESET } from "../../features/table-presets/system-preset.ts";
import { afterEach } from "vitest";
import { SteMemoryDatabase } from "./database.ts";
import { DexieSpaceStructureRebuild } from "./space/space-structure-rebuild-repository.ts";
import { SteMemoryLogDatabase } from "./logs/log-database.ts";
import { DexieMemoryFieldRepository } from "./memory/memory-field-repository.ts";
import { DexieMemoryRecordRepository } from "./memory/memory-record-repository.ts";
import { DexieMemorySpaceRepository } from "./memory/memory-space-repository.ts";
import { DexieMemoryTableRepository } from "./memory/memory-table-repository.ts";

/** 测试固定时钟（与既有 Memory / ST 适配器测试一致的语义） */
export const NOW = "2026-07-28T00:00:00.000Z";

let sequence = 0;
const databases: SteMemoryDatabase[] = [];
const logDatabases: SteMemoryLogDatabase[] = [];

/** 建一个互不冲突的测试库；afterEach 统一删除 */
export function createTestDatabase(name?: string): SteMemoryDatabase {
  const db = new SteMemoryDatabase(name ?? `ste-memory-test-${++sequence}`);
  databases.push(db);
  return db;
}

/** 建一个互不冲突的通用日志测试库（独立数据库，ADR 0015）；afterEach 统一删除 */
export function createTestLogDatabase(name?: string): SteMemoryLogDatabase {
  const db = new SteMemoryLogDatabase(name ?? `ste-memory-log-test-${++sequence}`);
  logDatabases.push(db);
  return db;
}

afterEach(async () => {
  const pending = databases.splice(0);
  const pendingLogs = logDatabases.splice(0);
  await Promise.all([...pending.map((db) => db.delete()), ...pendingLogs.map((db) => db.delete())]);
});

let presetIdSequence = 0;

/**
 * 把系统自带预设安装进空间（测试用）：与首次创建共用同一套
 * 表格预设实例化 + 原子重建路径（替代旧的 SystemMemoryTableInstaller）。
 * 实体 ID 用独立前缀，避免与 Memory 服务各自的 ID 序列相撞。
 */
export async function installDefaultPreset(
  db: SteMemoryDatabase,
  memorySpaceId: MemorySpaceId,
  now: () => string = () => NOW,
): Promise<void> {
  const apply = new TablePresetApplyService({
    validateStructure: async () => {},
    cancelActiveTask: async () => undefined,
    rebuild: new DexieSpaceStructureRebuild(db, new DexieMemorySpaceRepository(db)),
    defaultPreset: () => SYSTEM_TABLE_PRESET,
    currentChatIdentity: () => undefined,
    clearChatScopeMacros: () => undefined,
    createIds: {
      table: () => `preset-table-${++presetIdSequence}` as MemoryTableId,
      field: () => `preset-field-${++presetIdSequence}` as MemoryFieldId,
      group: () => `preset-group-${++presetIdSequence}`,
    },
    now,
  });
  await apply.installDefaultStructure(memorySpaceId);
}

export interface TestServices {
  /** 测试库（表格预设安装/原子重建等整库操作用） */
  db: SteMemoryDatabase;
  spaces: MemorySpaceService;
  tables: MemoryTableService;
  fields: MemoryFieldService;
  records: MemoryRecordService;
  spaceRepository: DexieMemorySpaceRepository;
  tableRepository: DexieMemoryTableRepository;
  fieldRepository: DexieMemoryFieldRepository;
  recordRepository: DexieMemoryRecordRepository;
}

/**
 * 把 Dexie 四个 repository 与 Memory 服务接成一套（id 自增、时钟可注入），
 * 供 integration / 存储层测试装配临时库与仓库。
 */
export function createServices(db: SteMemoryDatabase, now: () => string = () => NOW): TestServices {
  const spaceRepository = new DexieMemorySpaceRepository(db);
  const tableRepository = new DexieMemoryTableRepository(db);
  const fieldRepository = new DexieMemoryFieldRepository(db);
  const recordRepository = new DexieMemoryRecordRepository(db);
  let spaceSeq = 0;
  let tableSeq = 0;
  let fieldSeq = 0;
  let recordSeq = 0;
  let historySeq = 0;
  let revisionSeq = 0;
  let evidenceSeq = 0;
  return {
    db,
    spaces: new MemorySpaceService(
      spaceRepository,
      () => `space-${++spaceSeq}` as MemorySpaceId,
      now,
    ),
    tables: new MemoryTableService(
      spaceRepository,
      tableRepository,
      () => `table-${++tableSeq}` as MemoryTableId,
      now,
    ),
    fields: new MemoryFieldService(
      tableRepository,
      fieldRepository,
      () => `field-${++fieldSeq}` as MemoryFieldId,
      now,
    ),
    records: new MemoryRecordService(
      tableRepository,
      fieldRepository,
      recordRepository,
      () => `record-${++recordSeq}` as MemoryRecordId,
      () => `history-${++historySeq}` as MemoryRecordHistoryId,
      () => `revision-${++revisionSeq}` as MemoryRevisionId,
      now,
      recordRepository,
      () => `evidence-${++evidenceSeq}` as MemoryEvidenceId,
    ),
    spaceRepository,
    tableRepository,
    fieldRepository,
    recordRepository,
  };
}
