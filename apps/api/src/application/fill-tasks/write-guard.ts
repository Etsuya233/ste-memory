/**
 * FillTaskWriteGuard：填表任务期间的记忆空间只读保护（ticket 13）。
 *
 * 包装四个 manager（space/table/field/record），写方法先检查该空间是否有非终态
 * 填表任务：有则抛 FillTaskSpaceReadOnlyError（HTTP 层映射 409），读方法原样透传。
 * 任务自身的写入（批次提交、消息状态标记）不走本守卫。
 *
 * 注意：类实例方法在原型上，不能用对象展开委托，必须逐方法显式转发。
 */
import type {
  MemoryFieldUseCases,
  MemoryRecordId,
  MemoryRecordUseCases,
  MemoryRevisionId,
  MemoryRevisionSource,
  MemorySpaceId,
  MemoryTableId,
  MemoryTableUseCases,
} from "@ste-memory/core/memory";
import type { FillTask, FillTaskRepository } from "../ports/fill-task.ts";
import type { MemorySpaceManager } from "../ports/memory-space.ts";

/** 任务运行期间手动写被拒绝（HTTP 层映射 409，携带当前任务信息）。 */
export class FillTaskSpaceReadOnlyError extends Error {
  readonly task: FillTask;

  constructor(task: FillTask) {
    super(`记忆空间正在执行填表任务（${task.runId}），任务期间只读，请等待任务结束`);
    this.name = "FillTaskSpaceReadOnlyError";
    this.task = task;
  }
}

export interface WriteGuardedManagers {
  readonly spaces: MemorySpaceManager;
  readonly tables: MemoryTableUseCases;
  readonly fields: MemoryFieldUseCases;
  readonly records: MemoryRecordUseCases;
}

export class FillTaskWriteGuard {
  readonly #tasks: Pick<FillTaskRepository, "findActive">;
  readonly spaces: MemorySpaceManager;
  readonly tables: MemoryTableUseCases;
  readonly fields: MemoryFieldUseCases;
  readonly records: MemoryRecordUseCases;

  constructor(tasks: Pick<FillTaskRepository, "findActive">, managers: WriteGuardedManagers) {
    this.#tasks = tasks;
    this.spaces = this.#guardSpaces(managers.spaces);
    this.tables = this.#guardTables(managers.tables);
    this.fields = this.#guardFields(managers.fields);
    this.records = this.#guardRecords(managers.records);
  }

  async #assertWritable(memorySpaceId: MemorySpaceId): Promise<void> {
    const active = await this.#tasks.findActive(memorySpaceId);
    if (active) throw new FillTaskSpaceReadOnlyError(active);
  }

  #guardSpaces(spaces: MemorySpaceManager): MemorySpaceManager {
    return {
      create: (input) => spaces.create(input),
      rename: async (id, name) => {
        await this.#assertWritable(id);
        return spaces.rename(id, name);
      },
      delete: async (id) => {
        await this.#assertWritable(id);
        return spaces.delete(id);
      },
      exists: (id) => spaces.exists(id),
      list: () => spaces.list(),
      errors: (id) => spaces.errors(id),
      messages: (id, options) => spaces.messages(id, options),
    };
  }

  #guardTables(tables: MemoryTableUseCases): MemoryTableUseCases {
    return {
      create: async (memorySpaceId, input) => {
        await this.#assertWritable(memorySpaceId);
        return tables.create(memorySpaceId, input);
      },
      update: async (memorySpaceId, id, input) => {
        await this.#assertWritable(memorySpaceId);
        return tables.update(memorySpaceId, id, input);
      },
      delete: async (memorySpaceId, id) => {
        await this.#assertWritable(memorySpaceId);
        return tables.delete(memorySpaceId, id);
      },
      find: (memorySpaceId, id) => tables.find(memorySpaceId, id),
      list: (memorySpaceId) => tables.list(memorySpaceId),
    };
  }

  #guardFields(fields: MemoryFieldUseCases): MemoryFieldUseCases {
    return {
      create: async (memorySpaceId, tableId, input) => {
        await this.#assertWritable(memorySpaceId);
        return fields.create(memorySpaceId, tableId, input);
      },
      update: async (memorySpaceId, tableId, id, input) => {
        await this.#assertWritable(memorySpaceId);
        return fields.update(memorySpaceId, tableId, id, input);
      },
      setDisplayStrategy: async (memorySpaceId, tableId, strategy) => {
        await this.#assertWritable(memorySpaceId);
        return fields.setDisplayStrategy(memorySpaceId, tableId, strategy);
      },
      delete: async (memorySpaceId, tableId, id) => {
        await this.#assertWritable(memorySpaceId);
        return fields.delete(memorySpaceId, tableId, id);
      },
      find: (memorySpaceId, tableId, id) => fields.find(memorySpaceId, tableId, id),
      list: (memorySpaceId, tableId) => fields.list(memorySpaceId, tableId),
    };
  }

  #guardRecords(records: MemoryRecordUseCases): MemoryRecordUseCases {
    return {
      create: async (memorySpaceId, tableId, input) => {
        await this.#assertWritable(memorySpaceId);
        return records.create(memorySpaceId, tableId, input);
      },
      update: async (
        memorySpaceId: MemorySpaceId,
        tableId: MemoryTableId,
        id: MemoryRecordId,
        input: Parameters<MemoryRecordUseCases["update"]>[3],
      ) => {
        await this.#assertWritable(memorySpaceId);
        return records.update(memorySpaceId, tableId, id, input);
      },
      delete: async (
        memorySpaceId: MemorySpaceId,
        tableId: MemoryTableId,
        id: MemoryRecordId,
        expectedRevisionId: MemoryRevisionId,
        revisionSource: MemoryRevisionSource,
      ) => {
        await this.#assertWritable(memorySpaceId);
        return records.delete(memorySpaceId, tableId, id, expectedRevisionId, revisionSource);
      },
      find: (memorySpaceId, tableId, id) => records.find(memorySpaceId, tableId, id),
      list: (memorySpaceId, tableId, query) => records.list(memorySpaceId, tableId, query),
      listHistory: (memorySpaceId, query) => records.listHistory(memorySpaceId, query),
    };
  }
}
