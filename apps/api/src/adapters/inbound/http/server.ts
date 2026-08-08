import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { DomainError, type DomainErrorType } from "@ste-memory/core/memory";
import Fastify, { type FastifyInstance } from "fastify";
import { registerMemoryFieldRoutes } from "./memory-fields/routes.ts";
import type { MemoryFieldManager } from "../../../application/ports/memory-field.ts";
import type { DatabaseHealthCheck, SystemHealth } from "../../../application/ports/health.ts";
import { registerMemoryTableRoutes } from "./memory-tables/routes.ts";
import type { MemoryTableManager } from "../../../application/ports/memory-table.ts";
import { registerMemorySpaceRoutes } from "./memory-spaces/routes.ts";
import type { MemorySpaceManager } from "../../../application/ports/memory-space.ts";
import { registerMemoryRecordRoutes } from "./memory-records/routes.ts";
import type { MemoryRecordManager } from "../../../application/ports/memory-record.ts";
import type { MemoryRecordQueryManager } from "../../../application/ports/memory-record-query.ts";
import { registerChatRoutes } from "./chat/routes.ts";
import type { ChatManager } from "../../../application/ports/chat.ts";
import { registerFillTaskRoutes } from "./fill-tasks/routes.ts";
import type { FillTaskManager } from "../../../application/ports/fill-task-manager.ts";
import type { FillTaskEventBus } from "../../../application/ports/fill-task-events.ts";
import { FillTaskSpaceReadOnlyError } from "../../../application/fill-tasks/write-guard.ts";
import { registerCleaningRuleRoutes } from "./cleaning-rules/routes.ts";
import type { CleaningRuleManager } from "../../../application/ports/cleaning-rule.ts";

export interface ServerDependencies {
  readonly database: DatabaseHealthCheck;
  readonly memorySpaces: MemorySpaceManager;
  readonly memoryTables: MemoryTableManager;
  readonly memoryFields: MemoryFieldManager;
  readonly memoryRecords: MemoryRecordManager;
  readonly memoryRecordQueries: MemoryRecordQueryManager;
  readonly chat: ChatManager;
  readonly fillTasks: FillTaskManager;
  /** 填表任务事件流（ticket 16）：与 fillTasks 同一服务实现，HTTP 层经此订阅 SSE。 */
  readonly fillTaskEvents: FillTaskEventBus;
  readonly cleaningRules: CleaningRuleManager;
}

/**
 * 允许的跨源 Origin(浏览器 Web 页面)。
 * @fastify/cors 与 SSE hijack 响应共用:chat 路由 hijack 后 cors 钩子不再生效,需手动补头。
 */
export const ALLOWED_WEB_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

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
  memory_field_max_chars_invalid: "字段长度上限必须是正整数",
  memory_field_pattern_invalid: "字段值格式校验必须是合法正则表达式",
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
  memory_record_field_value_too_long: "记录字段值超过长度上限",
  memory_record_field_value_pattern_mismatch: "记录字段值不符合格式要求",
  memory_record_paging_invalid: "分页参数无效",
  memory_record_reference_invalid: "记录引用目标无效",
  memory_record_referenced: "记忆记录仍被当前记录引用，请先解除或转移引用",
  memory_record_revision_conflict: "记忆记录已更新，请刷新后重试",
  memory_record_required_field_missing: "记录缺少必填字段",
  memory_record_source_invalid: "记录来源格式无效",
  memory_record_query_invalid: "记录查询参数无效",
  memory_record_unknown_field: "记录包含未知字段",
  memory_evidence_storage_mode_conflict: "同一来源不能使用不同的证据存储模式",
  memory_backup_invalid_json: "备份文件不是有效的 JSON",
  memory_backup_format_invalid: "备份文件结构无效",
  memory_backup_version_unsupported: "备份文件版本不支持",
};

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });
  await server.register(cors, {
    origin: ALLOWED_WEB_ORIGIN,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await server.register(multipart, {
    limits: { files: 1, fileSize: 50 * 1024 * 1024, fields: 1 },
  });

  server.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof FillTaskSpaceReadOnlyError) {
      return reply.code(409).send({
        type: "fill_task_space_read_only",
        task: error.task,
        message: error.message,
      });
    }
    if (error instanceof DomainError) {
      const statusCode =
        error.type === "memory_record_revision_conflict" ||
        error.type === "memory_record_referenced" ||
        error.type === "memory_evidence_storage_mode_conflict"
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
  registerMemoryRecordRoutes(server, dependencies.memoryRecords, dependencies.memoryRecordQueries);
  registerChatRoutes(server, dependencies.chat);
  registerFillTaskRoutes(server, dependencies.fillTasks, dependencies.fillTaskEvents);
  registerCleaningRuleRoutes(server, dependencies.cleaningRules);

  return server;
}
