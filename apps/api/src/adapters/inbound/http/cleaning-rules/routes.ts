import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { FastifyInstance } from "fastify";
import type {
  CleaningRuleInput,
  CleaningRuleManager,
} from "../../../../application/ports/cleaning-rule.ts";
import {
  CleaningRuleValidationError,
  CleaningRuleReorderError,
} from "../../../../application/cleaning-rules/manager.ts";

interface IdParams {
  readonly id: string;
}

interface RuleParams extends IdParams {
  readonly ruleId: string;
}

export function registerCleaningRuleRoutes(
  server: FastifyInstance,
  cleaningRules: CleaningRuleManager,
): void {
  server.get<{ Params: IdParams }>("/memory-spaces/:id/cleaning-rules", async (request, reply) => {
    const rules = await cleaningRules.list(request.params.id as MemorySpaceId);
    return rules ?? reply.code(404).send({ message: "记忆空间不存在" });
  });

  server.post<{ Params: IdParams; Body: unknown }>(
    "/memory-spaces/:id/cleaning-rules",
    async (request, reply) => {
      try {
        const rule = await cleaningRules.create(
          request.params.id as MemorySpaceId,
          request.body as CleaningRuleInput,
        );
        return rule
          ? reply.code(201).send(rule)
          : reply.code(404).send({ message: "记忆空间不存在" });
      } catch (error) {
        if (error instanceof CleaningRuleValidationError) {
          return reply.code(400).send({ message: error.message });
        }
        throw error;
      }
    },
  );

  server.patch<{ Params: RuleParams; Body: unknown }>(
    "/memory-spaces/:id/cleaning-rules/:ruleId",
    async (request, reply) => {
      try {
        const rule = await cleaningRules.update(
          request.params.id as MemorySpaceId,
          request.params.ruleId,
          request.body as Parameters<CleaningRuleManager["update"]>[2],
        );
        return rule ?? reply.code(404).send({ message: "记忆空间或规则不存在" });
      } catch (error) {
        if (error instanceof CleaningRuleValidationError) {
          return reply.code(400).send({ message: error.message });
        }
        throw error;
      }
    },
  );

  server.delete<{ Params: RuleParams }>(
    "/memory-spaces/:id/cleaning-rules/:ruleId",
    async (request, reply) => {
      const removed = await cleaningRules.remove(
        request.params.id as MemorySpaceId,
        request.params.ruleId,
      );
      if (!removed) return reply.code(404).send({ message: "记忆空间或规则不存在" });
      return reply.code(204).send();
    },
  );

  server.put<{ Params: IdParams; Body: unknown }>(
    "/memory-spaces/:id/cleaning-rules/order",
    async (request, reply) => {
      const body = request.body as { readonly ruleIds?: unknown };
      if (!Array.isArray(body?.ruleIds) || !body.ruleIds.every((id) => typeof id === "string")) {
        return reply.code(400).send({ message: "ruleIds 必须是字符串数组" });
      }
      try {
        const rules = await cleaningRules.reorder(request.params.id as MemorySpaceId, body.ruleIds);
        return rules ?? reply.code(404).send({ message: "记忆空间不存在" });
      } catch (error) {
        if (error instanceof CleaningRuleReorderError) {
          return reply.code(400).send({ message: error.message });
        }
        throw error;
      }
    },
  );
}
