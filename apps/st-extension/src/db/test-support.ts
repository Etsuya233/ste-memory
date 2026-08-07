import "fake-indexeddb/auto";
import {
  MemoryFieldService,
  MemorySpaceService,
  MemoryTableService,
  type MemoryFieldId,
  type MemorySpaceId,
  type MemoryTableId,
} from "@ste-memory/core/memory";
import { afterEach } from "vitest";
import { SteMemoryDatabase } from "./database.ts";
import { DexieMemoryFieldRepository } from "./memory-field-repository.ts";
import { DexieMemorySpaceRepository } from "./memory-space-repository.ts";
import { DexieMemoryTableRepository } from "./memory-table-repository.ts";

/** 测试固定时钟（与 core/api 既有测试一致的语义） */
export const NOW = "2026-07-28T00:00:00.000Z";

let sequence = 0;
const databases: SteMemoryDatabase[] = [];

/** 建一个互不冲突的测试库；afterEach 统一删除 */
export function createTestDatabase(name?: string): SteMemoryDatabase {
  const db = new SteMemoryDatabase(name ?? `ste-memory-test-${++sequence}`);
  databases.push(db);
  return db;
}

afterEach(async () => {
  const pending = databases.splice(0);
  await Promise.all(pending.map((db) => db.delete()));
});

export interface TestServices {
  spaces: MemorySpaceService;
  tables: MemoryTableService;
  fields: MemoryFieldService;
  spaceRepository: DexieMemorySpaceRepository;
  tableRepository: DexieMemoryTableRepository;
  fieldRepository: DexieMemoryFieldRepository;
}

/**
 * 把 Dexie 三个 repository 与 core 服务接成一套（id 自增、时钟可注入），
 * 与 apps/api 的 createTestApplication 同形态。
 */
export function createServices(
  db: SteMemoryDatabase,
  now: () => string = () => NOW,
): TestServices {
  const spaceRepository = new DexieMemorySpaceRepository(db);
  const tableRepository = new DexieMemoryTableRepository(db);
  const fieldRepository = new DexieMemoryFieldRepository(db);
  let spaceSeq = 0;
  let tableSeq = 0;
  let fieldSeq = 0;
  return {
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
    spaceRepository,
    tableRepository,
    fieldRepository,
  };
}
