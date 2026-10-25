import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { MemorySpaceReader } from "../../../memory/index.ts";
import type { MemorySpaceTableDigest } from "../../digest.ts";

export const QUERY_SQL_TOOL_NAME = "query_sql";
export const QUERY_SQL_MAX_ROWS = 100;
const schema = Type.Object({ sql: Type.String({ minLength: 1 }) });
export interface QuerySqlToolResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
  readonly limit: number;
}
export interface QuerySqlToolDependencies {
  readonly reader: MemorySpaceReader & Required<Pick<MemorySpaceReader, "querySql">>;
  readonly digest: MemorySpaceTableDigest;
}

/** SQL authorization belongs to SQLite compilation; the tool never classifies SQL text. */
export function createQuerySqlTool(
  deps: QuerySqlToolDependencies,
): AgentTool<typeof schema, QuerySqlToolResult> {
  return {
    name: QUERY_SQL_TOOL_NAME,
    label: "SQL 查询记忆",
    description: [
      "只读 SQL 查询当前记忆空间，支持 AND/OR、括号、JOIN、聚合与子查询。",
      "表名和列名使用摘要中的表 Key、字段 Key；名称用双引号引用，字符串用单引号。",
      '系统列："$record_id"、"$display_text"、"$created_at"、"$updated_at"。引用列保存记录 ID，JOIN 目标表的 "$record_id"。',
      "列表列为 JSON 数组，可用 json_each(列) 查询成员；布尔值为 0/1，空值使用 IS NULL。",
      "只选需要的列，先按条件缩小范围并加 LIMIT；每次最多返回100行，执行预算由宿主限制。",
      "事务控制、PRAGMA、DDL 和所有写入均禁止。修改数据使用受控 mutate 工具。",
      "填表事务内可读取本轮已写入的记录；普通查询读取最近一次已提交数据。",
      "SQL 中的 $display_text 在查询前按当前引用与显示策略刷新，不作为记录身份。",
      `当前可查询表 Key：${deps.digest.tables.map((table) => table.key).join("、")}。`,
    ].join("\n"),
    parameters: schema,
    async execute(_id, params) {
      const rows = await deps.reader.querySql(deps.digest.memorySpaceId, params.sql);
      const result: QuerySqlToolResult = {
        rows: rows.slice(0, QUERY_SQL_MAX_ROWS),
        truncated: rows.length > QUERY_SQL_MAX_ROWS,
        limit: QUERY_SQL_MAX_ROWS,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

export function optionalQuerySqlTools(
  reader: MemorySpaceReader,
  digest: MemorySpaceTableDigest,
): ReturnType<typeof createQuerySqlTool>[] {
  return reader.querySql
    ? [createQuerySqlTool({ reader: reader as QuerySqlToolDependencies["reader"], digest })]
    : [];
}
