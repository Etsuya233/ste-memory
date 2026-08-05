import type { MemorySpaceId, MemorySpaceUseCases } from "@ste-memory/core/memory";
import type {
  CleaningRule,
  CleaningRuleInput,
  CleaningRuleManager,
  CleaningRuleRepository,
} from "../ports/cleaning-rule.ts";
import { validateCleaningRuleInput, validateCleaningRulePatchShape } from "./validate.ts";

export class CleaningRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleaningRuleValidationError";
  }
}

/** 重排的 id 集合与当前规则列表不匹配（HTTP 层映射 400）。 */
export class CleaningRuleReorderError extends Error {
  constructor() {
    super("规则 id 集合与当前规则列表不匹配");
    this.name = "CleaningRuleReorderError";
  }
}

/**
 * DefaultCleaningRuleManager：清洗规则（ADR apps/0001）的应用层编排。
 *
 * - 空间存在性检查：空间不存在时返回 undefined（HTTP 层映射 404）；
 * - 创建/更新前校验（名称、模式、正则语法、flags，见 validate.ts）；
 *   更新为部分补丁：与当前规则合并后整体校验，避免只改 enabled 时误伤其他字段；
 * - 重排 id 集合与当前列表不匹配时抛 CleaningRuleReorderError（400）。
 */
export class DefaultCleaningRuleManager implements CleaningRuleManager {
  readonly #rules: CleaningRuleRepository;
  readonly #spaces: Pick<MemorySpaceUseCases, "find">;

  constructor(rules: CleaningRuleRepository, spaces: Pick<MemorySpaceUseCases, "find">) {
    this.#rules = rules;
    this.#spaces = spaces;
  }

  async list(memorySpaceId: MemorySpaceId): Promise<readonly CleaningRule[] | undefined> {
    if (!(await this.#spaces.find(memorySpaceId))) return undefined;
    return this.#rules.list(memorySpaceId);
  }

  async create(
    memorySpaceId: MemorySpaceId,
    input: CleaningRuleInput,
  ): Promise<CleaningRule | undefined> {
    if (!(await this.#spaces.find(memorySpaceId))) return undefined;
    const validation = validateCleaningRuleInput(input);
    if (!validation.ok) throw new CleaningRuleValidationError(validation.message);
    return this.#rules.create(memorySpaceId, input);
  }

  async update(
    memorySpaceId: MemorySpaceId,
    ruleId: string,
    patch: Partial<CleaningRuleInput> & { readonly enabled?: boolean },
  ): Promise<CleaningRule | undefined> {
    if (!(await this.#spaces.find(memorySpaceId))) return undefined;
    const shape = validateCleaningRulePatchShape(patch);
    if (!shape.ok) throw new CleaningRuleValidationError(shape.message);
    const current = await this.#rules.find(memorySpaceId, ruleId);
    if (!current) return undefined;
    const merged: CleaningRuleInput = {
      name: patch.name ?? current.name,
      mode: patch.mode ?? current.mode,
      pattern: patch.pattern ?? current.pattern,
      flags: patch.flags ?? current.flags,
    };
    const validation = validateCleaningRuleInput(merged);
    if (!validation.ok) throw new CleaningRuleValidationError(validation.message);
    return this.#rules.update(memorySpaceId, ruleId, {
      ...merged,
      enabled: patch.enabled ?? current.enabled,
    });
  }

  async remove(memorySpaceId: MemorySpaceId, ruleId: string): Promise<boolean> {
    if (!(await this.#spaces.find(memorySpaceId))) return false;
    return this.#rules.remove(memorySpaceId, ruleId);
  }

  async reorder(
    memorySpaceId: MemorySpaceId,
    ruleIds: readonly string[],
  ): Promise<readonly CleaningRule[] | undefined> {
    if (!(await this.#spaces.find(memorySpaceId))) return undefined;
    const rules = await this.#rules.reorder(memorySpaceId, ruleIds);
    if (!rules) throw new CleaningRuleReorderError();
    return rules;
  }
}
