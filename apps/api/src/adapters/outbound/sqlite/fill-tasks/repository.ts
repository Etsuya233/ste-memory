import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { DatabaseContext } from "../database/database-context.ts";
import type { FillTask, FillTaskRepository } from "../../../../application/ports/fill-task.ts";

export class KyselyFillTaskRepository implements FillTaskRepository {
  readonly #context: DatabaseContext;

  constructor(context: DatabaseContext) {
    this.#context = context;
  }

  async create(task: FillTask): Promise<void> {
    await this.#context.database
      .insertInto("memory_fill_tasks")
      .values({
        run_id: task.runId,
        memory_space_id: task.memorySpaceId,
        from_source_id: task.from,
        to_source_id: task.to,
        block_size: task.blockSize,
        status: task.status,
        error_message: task.errorMessage,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
      })
      .execute();
  }

  async findActive(memorySpaceId: MemorySpaceId): Promise<FillTask | undefined> {
    const row = await this.#context.database
      .selectFrom("memory_fill_tasks")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("status", "not in", ["succeeded", "failed"])
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    return row ? toFillTask(row) : undefined;
  }

  async markSucceeded(runId: string): Promise<void> {
    await this.#context.database
      .updateTable("memory_fill_tasks")
      .set({ status: "succeeded", error_message: null, updated_at: new Date().toISOString() })
      .where("run_id", "=", runId)
      .execute();
  }

  async markFailed(runId: string, errorMessage: string): Promise<void> {
    await this.#context.database
      .updateTable("memory_fill_tasks")
      .set({ status: "failed", error_message: errorMessage, updated_at: new Date().toISOString() })
      .where("run_id", "=", runId)
      .execute();
  }
}

function toFillTask(row: {
  readonly run_id: string;
  readonly memory_space_id: string;
  readonly from_source_id: number;
  readonly to_source_id: number;
  readonly block_size: number;
  readonly status: "running" | "succeeded" | "failed";
  readonly error_message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}): FillTask {
  return {
    runId: row.run_id,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    from: row.from_source_id,
    to: row.to_source_id,
    blockSize: row.block_size,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
