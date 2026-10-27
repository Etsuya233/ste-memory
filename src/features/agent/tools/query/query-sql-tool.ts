import { effectiveVectorIndexGroups } from "../../../memory/index.ts";
import type {
  SemanticQueryExecutor,
  SemanticQueryResponse,
} from "../../../semantic-query/semantic-query-session.ts";
import { SemanticQueryError } from "../../../semantic-query/semantic-query-service.ts";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { MemorySpaceReader } from "../../../memory/index.ts";
import type { MemorySpaceTableDigest } from "../../digest.ts";

export const QUERY_SQL_TOOL_NAME = "query_sql";
export const QUERY_SQL_MAX_ROWS = 100;
const schema = Type.Object({ sql: Type.String({ minLength: 1 }) });
export interface QuerySqlToolResult {
  readonly columns?: readonly string[];
  readonly sources?: readonly {
    readonly table: string;
    readonly groups: readonly string[];
    readonly query: string;
    readonly coverage: SemanticQueryResponse["sources"][number]["coverage"];
  }[];
  readonly diagnostics?: SemanticQueryResponse["diagnostics"];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
  readonly limit: number;
}
export type QuerySqlToolDependencies =
  | {
      readonly reader: MemorySpaceReader & Required<Pick<MemorySpaceReader, "querySql">>;
      readonly digest: MemorySpaceTableDigest;
      readonly query?: undefined;
      readonly semanticDescription?: undefined;
    }
  | {
      readonly query: SemanticQueryExecutor;
      readonly digest: MemorySpaceTableDigest;
      readonly semanticDescription: string;
    };

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
      deps.query
        ? "事务控制、PRAGMA、DDL 和所有写入均禁止。"
        : "事务控制、PRAGMA、DDL 和所有写入均禁止。修改数据使用受控 mutate 工具。",
      deps.query
        ? "每次调用读取新的已提交记忆快照。"
        : "填表事务内可读取本轮已写入的记录；普通查询读取最近一次已提交数据。",
      "SQL 中的 $display_text 在查询前按当前引用与显示策略刷新，不作为记录身份。",
      ...(deps.semanticDescription ? [deps.semanticDescription] : []),
      `当前可查询表 Key：${deps.digest.tables.map((table) => table.key).join("、")}。`,
    ].join("\n"),
    parameters: schema,
    async execute(_id, params, signal) {
      let result: QuerySqlToolResult;
      if (deps.query) {
        try {
          const response = await deps.query(deps.digest.memorySpaceId, {
            sql: params.sql,
            signal,
            maxRows: QUERY_SQL_MAX_ROWS,
          });
          result = {
            columns: response.columns,
            rows: response.rows.map((row) =>
              Object.fromEntries(
                response.columns.map((column, index) => {
                  const value = row[index];
                  return [
                    column,
                    typeof value === "bigint"
                      ? value.toString()
                      : value instanceof Uint8Array
                        ? Array.from(value)
                        : value,
                  ];
                }),
              ),
            ),
            truncated: response.truncated,
            limit: QUERY_SQL_MAX_ROWS,
            sources: response.sources.map(({ table, groups, query, coverage }) => ({
              table,
              groups,
              query,
              coverage,
            })),
            diagnostics: response.diagnostics,
          };
        } catch (error) {
          if (!(error instanceof SemanticQueryError)) throw error;
          throw new Error(
            JSON.stringify({ error: error.message, diagnostics: error.diagnostics }),
            { cause: error },
          );
        }
      } else {
        const rows = await deps.reader.querySql(deps.digest.memorySpaceId, params.sql);
        result = {
          rows: rows.slice(0, QUERY_SQL_MAX_ROWS),
          truncated: rows.length > QUERY_SQL_MAX_ROWS,
          limit: QUERY_SQL_MAX_ROWS,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  };
}

export function optionalQuerySqlTools(
  reader: MemorySpaceReader,
  digest: MemorySpaceTableDigest,
): ReturnType<typeof createQuerySqlTool>[] {
  return reader.querySql
    ? [
        createQuerySqlTool({
          reader: reader as MemorySpaceReader & Required<Pick<MemorySpaceReader, "querySql">>,
          digest,
        }),
      ]
    : [];
}

/** QueryAgent uses the same SQL tool name and arguments for ordinary and semantic queries. */
export async function createQueryAgentSqlTool(input: {
  reader: MemorySpaceReader;
  digest: MemorySpaceTableDigest;
  query: SemanticQueryExecutor;
}): Promise<AgentTool<typeof schema, QuerySqlToolResult>> {
  const tables = await input.reader.listTables(input.digest.memorySpaceId);
  const groups = await Promise.all(
    tables
      .filter((table) => table.enabled && table.vectorIndex?.enabled)
      .map(async (table) => {
        const fields = (await input.reader.listFields(input.digest.memorySpaceId, table.id)).filter(
          (field) => field.enabled,
        );
        return {
          table: table.key,
          groups: effectiveVectorIndexGroups(table.vectorIndex!, fields)
            .filter(
              (group) =>
                group.fieldIds.length &&
                group.fieldIds.every((id) => fields.some((field) => field.id === id)),
            )
            .map((group) => ({
              key: group.key,
              fields: group.fieldIds.map((id) => fields.find((field) => field.id === id)!.key),
            })),
        };
      }),
  );
  return createQuerySqlTool({
    digest: input.digest,
    query: input.query,
    semanticDescription: [
      "可直接在 SQL 中使用 semantic_scores(table_key, groups_json, query_text)，返回 record_id、score、group_key；每条记录取所选组最高分，评分源不预先截取 Top K。",
      `示例：SELECT t."$display_text",s.score FROM "表Key" t JOIN semantic_scores('表Key',json_array('组Key'),'查询文本') s ON s.record_id=t."$record_id" ORDER BY s.score DESC LIMIT 10。`,
      "在 SQL 中填写实际查询文本，不读取 ST 输入或宏上下文。普通 SQL 和语义 SQL 均使用本工具，无需切换入口。",
      "只搜索已有有效索引，不补建；检查返回的索引覆盖，区分无有效索引和零命中，不能据此断言记忆中没有相关事实。",
      "总等待 10 秒，累计 SQL 1 秒，最多 16 个源、4 种查询文本。相同查询向量可命中短期缓存。",
      `可用向量组及字段：${JSON.stringify(groups)}`,
    ].join("\n"),
  });
}
