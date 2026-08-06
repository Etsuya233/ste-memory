import type {
  CreateMemoryFieldInput,
  MemoryFieldType,
  MemoryFieldId,
  MemorySpaceId,
  MemoryTableDisplayStrategy,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type { FastifyInstance } from "fastify";
import type { MemoryFieldManager } from "../../../../application/ports/memory-field.ts";
import type { MemoryTableManager } from "../../../../application/ports/memory-table.ts";

interface TableParams {
  readonly spaceId: string;
  readonly tableId: string;
}

interface CreateFieldBody {
  readonly key?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly required?: unknown;
  readonly prompt?: unknown;
  readonly enabled?: unknown;
  readonly position?: unknown;
  readonly options?: unknown;
  readonly referenceTableId?: unknown;
  readonly maxChars?: unknown;
  readonly valuePattern?: unknown;
  readonly valuePatternMessage?: unknown;
}

interface FieldParams extends TableParams {
  readonly fieldId: string;
}

type UpdateFieldBody = CreateFieldBody;

interface DisplayStrategyBody {
  readonly type?: unknown;
  readonly fieldId?: unknown;
  readonly template?: unknown;
}

const FIELD_TYPES = new Set<MemoryFieldType>([
  "short_text",
  "long_text",
  "short_text_list",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "single_reference",
  "multi_reference",
]);

export function registerMemoryFieldRoutes(
  server: FastifyInstance,
  memoryTables: MemoryTableManager,
  memoryFields: MemoryFieldManager,
): void {
  server.get<{ Params: TableParams }>(
    "/memory-spaces/:spaceId/tables/:tableId/fields",
    async (request, reply) => {
      const memorySpaceId = request.params.spaceId as MemorySpaceId;
      const tableId = request.params.tableId as MemoryTableId;
      if (!(await memoryTables.find(memorySpaceId, tableId))) {
        return reply.code(404).send({ message: "记忆表格不存在" });
      }
      return memoryFields.list(memorySpaceId, tableId);
    },
  );

  server.post<{ Params: TableParams; Body: CreateFieldBody }>(
    "/memory-spaces/:spaceId/tables/:tableId/fields",
    async (request, reply) => {
      const body = request.body;
      if (typeof body?.name !== "string") {
        return reply.code(400).send({ message: "字段名称必须是文本" });
      }
      if (typeof body.key !== "string") {
        return reply.code(400).send({ message: "字段 Key 必须是文本" });
      }
      if (typeof body.type !== "string" || !FIELD_TYPES.has(body.type as MemoryFieldType)) {
        return reply.code(400).send({ message: "字段类型不受支持" });
      }
      if (typeof body.required !== "boolean" || typeof body.enabled !== "boolean") {
        return reply.code(400).send({ message: "字段必填和启用状态必须是布尔值" });
      }
      if (typeof body.prompt !== "string") {
        return reply.code(400).send({ message: "字段 Prompt 必须是文本" });
      }
      if (typeof body.position !== "number") {
        return reply.code(400).send({ message: "字段顺序必须是数字" });
      }
      if (
        body.options !== undefined &&
        (!Array.isArray(body.options) || body.options.some((option) => typeof option !== "string"))
      ) {
        return reply.code(400).send({ message: "固定选项必须是文本数组" });
      }
      if (body.referenceTableId !== undefined && typeof body.referenceTableId !== "string") {
        return reply.code(400).send({ message: "引用目标表 ID 必须是文本" });
      }
      if (
        body.maxChars !== undefined &&
        body.maxChars !== null &&
        (typeof body.maxChars !== "number" || !Number.isInteger(body.maxChars) || body.maxChars < 1)
      ) {
        return reply.code(400).send({ message: "字段长度上限必须是正整数" });
      }
      if (body.valuePattern !== undefined && body.valuePattern !== null && typeof body.valuePattern !== "string") {
        return reply.code(400).send({ message: "字段值格式校验必须是文本" });
      }
      if (
        body.valuePatternMessage !== undefined &&
        body.valuePatternMessage !== null &&
        typeof body.valuePatternMessage !== "string"
      ) {
        return reply.code(400).send({ message: "字段格式说明必须是文本" });
      }
      const input: CreateMemoryFieldInput = {
        key: body.key,
        name: body.name,
        type: body.type as MemoryFieldType,
        required: body.required,
        prompt: body.prompt,
        enabled: body.enabled,
        position: body.position,
        options: body.options as string[] | undefined,
        referenceTableId: body.referenceTableId as MemoryTableId | undefined,
        maxChars: body.maxChars as number | null | undefined,
        valuePattern: body.valuePattern as string | null | undefined,
        valuePatternMessage: body.valuePatternMessage as string | null | undefined,
      };
      const created = await memoryFields.create(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        input,
      );
      return created
        ? reply.code(201).send(created)
        : reply.code(404).send({ message: "记忆表格不存在" });
    },
  );

  server.get<{ Params: FieldParams }>(
    "/memory-spaces/:spaceId/tables/:tableId/fields/:fieldId",
    async (request, reply) => {
      const field = await memoryFields.find(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        request.params.fieldId as MemoryFieldId,
      );
      return field ?? reply.code(404).send({ message: "字段不存在" });
    },
  );

  server.patch<{ Params: FieldParams; Body: UpdateFieldBody }>(
    "/memory-spaces/:spaceId/tables/:tableId/fields/:fieldId",
    async (request, reply) => {
      const body = request.body;
      if (body?.name !== undefined && typeof body.name !== "string") {
        return reply.code(400).send({ message: "字段名称必须是文本" });
      }
      if (body?.key !== undefined && typeof body.key !== "string") {
        return reply.code(400).send({ message: "字段 Key 必须是文本" });
      }
      if (
        body?.type !== undefined &&
        (typeof body.type !== "string" || !FIELD_TYPES.has(body.type as MemoryFieldType))
      ) {
        return reply.code(400).send({ message: "字段类型不受支持" });
      }
      if (body?.required !== undefined && typeof body.required !== "boolean") {
        return reply.code(400).send({ message: "字段必填状态必须是布尔值" });
      }
      if (body?.enabled !== undefined && typeof body.enabled !== "boolean") {
        return reply.code(400).send({ message: "字段启用状态必须是布尔值" });
      }
      if (body?.prompt !== undefined && typeof body.prompt !== "string") {
        return reply.code(400).send({ message: "字段 Prompt 必须是文本" });
      }
      if (body?.position !== undefined && typeof body.position !== "number") {
        return reply.code(400).send({ message: "字段顺序必须是数字" });
      }
      if (
        body?.options !== undefined &&
        (!Array.isArray(body.options) || body.options.some((option) => typeof option !== "string"))
      ) {
        return reply.code(400).send({ message: "固定选项必须是文本数组" });
      }
      if (
        body?.referenceTableId !== undefined &&
        body.referenceTableId !== null &&
        typeof body.referenceTableId !== "string"
      ) {
        return reply.code(400).send({ message: "引用目标表 ID 必须是文本" });
      }
      if (
        body?.maxChars !== undefined &&
        body.maxChars !== null &&
        (typeof body.maxChars !== "number" || !Number.isInteger(body.maxChars) || body.maxChars < 1)
      ) {
        return reply.code(400).send({ message: "字段长度上限必须是正整数" });
      }
      if (
        body?.valuePattern !== undefined &&
        body.valuePattern !== null &&
        typeof body.valuePattern !== "string"
      ) {
        return reply.code(400).send({ message: "字段值格式校验必须是文本" });
      }
      if (
        body?.valuePatternMessage !== undefined &&
        body.valuePatternMessage !== null &&
        typeof body.valuePatternMessage !== "string"
      ) {
        return reply.code(400).send({ message: "字段格式说明必须是文本" });
      }
      const updated = await memoryFields.update(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        request.params.fieldId as MemoryFieldId,
        {
          key: body?.key as string | undefined,
          name: body?.name as string | undefined,
          type: body?.type as MemoryFieldType | undefined,
          required: body?.required as boolean | undefined,
          prompt: body?.prompt as string | undefined,
          enabled: body?.enabled as boolean | undefined,
          position: body?.position as number | undefined,
          options: body?.options as string[] | undefined,
          referenceTableId: body?.referenceTableId as MemoryTableId | null | undefined,
          maxChars: body?.maxChars as number | null | undefined,
          valuePattern: body?.valuePattern as string | null | undefined,
          valuePatternMessage: body?.valuePatternMessage as string | null | undefined,
        },
      );
      return updated ?? reply.code(404).send({ message: "字段不存在" });
    },
  );

  server.delete<{ Params: FieldParams }>(
    "/memory-spaces/:spaceId/tables/:tableId/fields/:fieldId",
    async (request, reply) => {
      const deleted = await memoryFields.delete(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        request.params.fieldId as MemoryFieldId,
      );
      return deleted ? reply.code(204).send() : reply.code(404).send({ message: "字段不存在" });
    },
  );

  server.put<{ Params: TableParams; Body: DisplayStrategyBody }>(
    "/memory-spaces/:spaceId/tables/:tableId/display-strategy",
    async (request, reply) => {
      const body = request.body;
      let strategy: MemoryTableDisplayStrategy;
      if (body?.type === "field" && typeof body.fieldId === "string") {
        strategy = { type: "field", fieldId: body.fieldId as MemoryFieldId };
      } else if (body?.type === "template" && typeof body.template === "string") {
        strategy = { type: "template", template: body.template };
      } else {
        return reply.code(400).send({ message: "显示策略配置无效" });
      }
      const updated = await memoryFields.setDisplayStrategy(
        request.params.spaceId as MemorySpaceId,
        request.params.tableId as MemoryTableId,
        strategy,
      );
      return updated ?? reply.code(404).send({ message: "记忆表格不存在" });
    },
  );
}
