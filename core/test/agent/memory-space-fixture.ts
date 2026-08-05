import {
  MemoryFieldService,
  MemoryRecordQueryService,
  MemoryTableService,
  type MemoryField,
  type MemoryProposalPorts,
  type MemoryRecord,
  type MemoryTable,
  type MemoryTableId,
} from "../../src/memory/index.ts";
import type {
  MemoryFieldRepository,
  MemoryRecordRepository,
  MemorySpaceRepository,
  MemoryTableRepository,
} from "../../src/memory/adapter.ts";
import type { MemorySpaceReader } from "../../src/agent/index.ts";
import {
  SPACE_ID,
  TABLES,
  FIELDS_BY_TABLE_ID,
  RECORDS_BY_TABLE_ID,
  listFieldsOf,
  listRecordsOf,
} from "./memory-space-data.ts";

const timestamp = "2026-07-30T00:00:00.000Z";

export interface TestMemorySpace {
  readonly memorySpaceId: MemorySpaceId;
  readonly reader: MemorySpaceReader;
  /** 提案校验/预览所需的领域访问端口（与宿主装配方式一致）。 */
  readonly ports: MemoryProposalPorts;
  readonly tables: readonly MemoryTable[];
  readonly fieldsByTableId: ReadonlyMap<MemoryTableId, readonly MemoryField[]>;
  readonly recordsByTableId: ReadonlyMap<MemoryTableId, readonly MemoryRecord[]>;
}

/**
 * 装配一个内存记忆空间：真实应用层服务 + 假仓库，reader 端口结构兼容宿主装配方式
 * （宿主在 11.5 用同样的 UseCases 组合实现 MemorySpaceReader）。
 */
export function createTestMemorySpace(): TestMemorySpace {
  const tablesRepo: MemoryTableRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(memorySpaceId, id) {
      return memorySpaceId === SPACE_ID
        ? TABLES.find((candidate) => candidate.id === id)
        : undefined;
    },
    async findByKey() {
      return undefined;
    },
    async list(memorySpaceId) {
      return memorySpaceId === SPACE_ID ? [...TABLES] : [];
    },
    async update() {
      return false;
    },
  };
  const fieldsRepo: MemoryFieldRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find(memorySpaceId, tableId, id) {
      return listFieldsOf(memorySpaceId, tableId).find((candidate) => candidate.id === id);
    },
    async findByKey() {
      return undefined;
    },
    async list(memorySpaceId, tableId) {
      return listFieldsOf(memorySpaceId, tableId);
    },
    async update() {
      return false;
    },
  };
  const recordsRepo: MemoryRecordRepository = {
    async create() {},
    async find(memorySpaceId, tableId, id) {
      return listRecordsOf(memorySpaceId, tableId).find((candidate) => candidate.id === id);
    },
    async list(memorySpaceId, tableId) {
      return listRecordsOf(memorySpaceId, tableId);
    },
    async commit() {
      return false;
    },
    async listHistory() {
      return [];
    },
  };
  const spacesRepo: MemorySpaceRepository = {
    async create() {},
    async delete() {
      return false;
    },
    async find() {
      return undefined;
    },
    async list() {
      return [];
    },
    async rename() {
      return undefined;
    },
  };
  const createId = (() => `id-${Math.random().toString(36).slice(2)}`) as () => MemoryTableId;

  const tableService = new MemoryTableService(spacesRepo, tablesRepo, createId, () => timestamp);
  const fieldService = new MemoryFieldService(tablesRepo, fieldsRepo, createId, () => timestamp);
  const queryService = new MemoryRecordQueryService(tablesRepo, fieldsRepo, recordsRepo);
  const reader: MemorySpaceReader = {
    listTables: (memorySpaceId) => tableService.list(memorySpaceId),
    listFields: (memorySpaceId, tableId) => fieldService.list(memorySpaceId, tableId),
    queryRecords: (memorySpaceId, input) => queryService.query(memorySpaceId, input),
  };

  return {
    memorySpaceId: SPACE_ID,
    reader,
    ports: { tables: tablesRepo, fields: fieldsRepo, records: recordsRepo },
    tables: TABLES,
    fieldsByTableId: FIELDS_BY_TABLE_ID,
    recordsByTableId: RECORDS_BY_TABLE_ID,
  };
}
