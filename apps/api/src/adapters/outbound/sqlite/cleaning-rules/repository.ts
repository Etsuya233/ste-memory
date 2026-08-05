import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { UnitOfWork } from "@ste-memory/tools";
import type { DatabaseContext } from "../database/database-context.ts";
import type {
  CleaningRule,
  CleaningRuleInput,
  CleaningRuleRepository,
} from "../../../../application/ports/cleaning-rule.ts";

function toCleaningRule(row: {
  readonly id: string;
  readonly memory_space_id: string;
  readonly position: number;
  readonly enabled: number;
  readonly name: string;
  readonly mode: "keep" | "discard";
  readonly pattern: string;
  readonly flags: string;
}): CleaningRule {
  return {
    id: row.id,
    memorySpaceId: row.memory_space_id as MemorySpaceId,
    position: row.position,
    enabled: row.enabled === 1,
    name: row.name,
    mode: row.mode,
    pattern: row.pattern,
    flags: row.flags,
  };
}

export class KyselyCleaningRuleRepository implements CleaningRuleRepository {
  readonly #context: DatabaseContext;
  readonly #unitOfWork: UnitOfWork;
  readonly #createId: () => string;
  readonly #now: () => string;

  constructor(
    context: DatabaseContext,
    unitOfWork: UnitOfWork,
    createId: () => string,
    now: () => string,
  ) {
    this.#context = context;
    this.#unitOfWork = unitOfWork;
    this.#createId = createId;
    this.#now = now;
  }

  async list(memorySpaceId: MemorySpaceId): Promise<readonly CleaningRule[]> {
    const rows = await this.#context.database
      .selectFrom("cleaning_rules")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .orderBy("position")
      .execute();
    return rows.map(toCleaningRule);
  }

  async find(memorySpaceId: MemorySpaceId, ruleId: string): Promise<CleaningRule | undefined> {
    const row = await this.#context.database
      .selectFrom("cleaning_rules")
      .selectAll()
      .where("memory_space_id", "=", memorySpaceId)
      .where("id", "=", ruleId)
      .executeTakeFirst();
    return row ? toCleaningRule(row) : undefined;
  }

  async create(memorySpaceId: MemorySpaceId, input: CleaningRuleInput): Promise<CleaningRule> {
    const now = this.#now();
    return this.#unitOfWork.run(async () => {
      const { position } = await this.#context.database
        .selectFrom("cleaning_rules")
        .select(({ fn }) => fn.max<number>("position").as("position"))
        .where("memory_space_id", "=", memorySpaceId)
        .executeTakeFirstOrThrow();
      const rule: CleaningRule = {
        id: this.#createId(),
        memorySpaceId,
        position: (position ?? -1) + 1,
        enabled: input.enabled ?? true,
        name: input.name.trim(),
        mode: input.mode,
        pattern: input.pattern,
        flags: input.flags,
      };
      await this.#context.database
        .insertInto("cleaning_rules")
        .values({
          id: rule.id,
          memory_space_id: memorySpaceId,
          position: rule.position,
          enabled: rule.enabled ? 1 : 0,
          name: rule.name,
          mode: rule.mode,
          pattern: rule.pattern,
          flags: rule.flags,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return rule;
    });
  }

  async update(
    memorySpaceId: MemorySpaceId,
    ruleId: string,
    patch: CleaningRuleInput & { readonly enabled: boolean },
  ): Promise<CleaningRule | undefined> {
    const now = this.#now();
    await this.#context.database
      .updateTable("cleaning_rules")
      .set({
        enabled: patch.enabled ? 1 : 0,
        name: patch.name.trim(),
        mode: patch.mode,
        pattern: patch.pattern,
        flags: patch.flags,
        updated_at: now,
      })
      .where("memory_space_id", "=", memorySpaceId)
      .where("id", "=", ruleId)
      .execute();
    return this.find(memorySpaceId, ruleId);
  }

  async remove(memorySpaceId: MemorySpaceId, ruleId: string): Promise<boolean> {
    return this.#unitOfWork.run(async () => {
      const deleted = await this.#context.database
        .deleteFrom("cleaning_rules")
        .where("memory_space_id", "=", memorySpaceId)
        .where("id", "=", ruleId)
        .executeTakeFirst();
      if (deleted.numDeletedRows === 0n) return false;
      await this.#renumber(memorySpaceId);
      return true;
    });
  }

  async reorder(
    memorySpaceId: MemorySpaceId,
    ruleIds: readonly string[],
  ): Promise<readonly CleaningRule[] | undefined> {
    return this.#unitOfWork.run(async () => {
      const existing = await this.list(memorySpaceId);
      if (new Set(ruleIds).size !== ruleIds.length || ruleIds.length !== existing.length) {
        return undefined;
      }
      for (const ruleId of ruleIds) {
        if (!existing.some((rule) => rule.id === ruleId)) return undefined;
      }
      const now = this.#now();
      for (const [position, ruleId] of ruleIds.entries()) {
        await this.#context.database
          .updateTable("cleaning_rules")
          .set({ position, updated_at: now })
          .where("memory_space_id", "=", memorySpaceId)
          .where("id", "=", ruleId)
          .execute();
      }
      return this.list(memorySpaceId);
    });
  }

  /** 删除后把剩余规则的 position 重排为连续下标。 */
  async #renumber(memorySpaceId: MemorySpaceId): Promise<void> {
    const remaining = await this.list(memorySpaceId);
    const now = this.#now();
    for (const [position, rule] of remaining.entries()) {
      await this.#context.database
        .updateTable("cleaning_rules")
        .set({ position, updated_at: now })
        .where("memory_space_id", "=", memorySpaceId)
        .where("id", "=", rule.id)
        .execute();
    }
  }
}
