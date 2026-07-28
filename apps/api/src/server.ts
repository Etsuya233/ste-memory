import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { DomainError, type DomainErrorType } from "@ste-memory/core";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMemoryFieldRoutes } from "./memory-fields/routes.ts";
import type { MemoryFieldManager } from "./memory-fields/types.ts";
import type { DatabaseHealthCheck, SystemHealth } from "./health/types.ts";
import { registerMemoryTableRoutes } from "./memory-tables/routes.ts";
import type { MemoryTableManager } from "./memory-tables/types.ts";
import { registerMemorySpaceRoutes } from "./memory-spaces/routes.ts";
import type { MemorySpaceManager } from "./memory-spaces/types.ts";
import { registerMemoryRecordRoutes } from "./memory-records/routes.ts";
import type { MemoryRecordManager } from "./memory-records/types.ts";

export interface ServerDependencies {
  readonly database: DatabaseHealthCheck;
  readonly memorySpaces: MemorySpaceManager;
  readonly memoryTables: MemoryTableManager;
  readonly memoryFields: MemoryFieldManager;
  readonly memoryRecords: MemoryRecordManager;
}

const domainErrorMessages: Record<DomainErrorType, string> = {
  memory_space_name_required: "记忆空间名称不能为空",
  memory_space_name_too_long: "记忆空间名称不能超过 120 个字符",
  memory_table_name_required: "记忆表格名称不能为空",
  memory_table_name_too_long: "记忆表格名称不能超过 120 个字符",
  memory_table_key_required: "记忆表格 Key 不能为空",
  memory_table_key_too_long: "记忆表格 Key 不能超过 120 个字符",
  memory_table_key_conflict: "同一记忆空间内的表格 Key 不能重复",
  memory_field_reference_table_invalid: "引用字段的目标表必须属于当前记忆空间",
  memory_field_options_invalid: "单选和多选字段需要互不重复的非空固定选项",
  memory_field_type_immutable: "字段创建后不能修改类型",
  memory_field_name_required: "字段名称不能为空",
  memory_field_name_too_long: "字段名称不能超过 120 个字符",
  memory_field_key_required: "字段 Key 不能为空",
  memory_field_key_too_long: "字段 Key 不能超过 120 个字符",
  memory_field_key_conflict: "同一表格内的字段 Key 不能重复",
  memory_field_position_invalid: "字段顺序必须是大于或等于 0 的整数",
  memory_table_display_strategy_invalid: "记忆表格显示策略无效",
  memory_field_used_by_display_strategy: "请先指定不使用该字段的其他显示策略，再删除或停用该字段",
  memory_record_display_strategy_missing: "创建记录前必须配置表格显示策略",
  memory_record_not_found: "记忆记录不存在",
  memory_record_field_value_invalid: "记录字段值格式无效",
  memory_record_paging_invalid: "分页参数无效",
  memory_record_reference_invalid: "记录引用目标无效",
  memory_record_referenced: "记忆记录仍被当前记录引用，请先解除或转移引用",
  memory_record_revision_conflict: "记忆记录已更新，请刷新后重试",
  memory_record_required_field_missing: "记录缺少必填字段",
  memory_record_source_invalid: "记录来源格式无效",
  memory_record_unknown_field: "记录包含未知字段",
};

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });
  await server.register(cors, {
    origin: /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await server.register(multipart, {
    limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 1 },
  });

  server.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof DomainError) {
      const statusCode =
        error.type === "memory_record_revision_conflict" ||
        error.type === "memory_record_referenced"
          ? 409
          : error.type === "memory_record_not_found"
            ? 404
            : 400;
      return reply.code(statusCode).send({
        type: error.type,
        param: error.param,
        message: domainErrorMessages[error.type],
      });
    }
    return reply.send(error);
  });

  server.get("/health", async (): Promise<SystemHealth> => ({
    api: "ok",
    database: await dependencies.database.check(),
  }));
  registerMemorySpaceRoutes(server, dependencies.memorySpaces);
  registerMemoryTableRoutes(server, dependencies.memorySpaces, dependencies.memoryTables);
  registerMemoryFieldRoutes(server, dependencies.memoryTables, dependencies.memoryFields);
  registerMemoryRecordRoutes(server, dependencies.memoryRecords);

  return server;
}
