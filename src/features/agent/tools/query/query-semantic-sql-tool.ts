import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { effectiveVectorIndexGroups, type MemorySpaceReader } from "../../../memory/index.ts";
import type { SemanticQueryExecutor } from "../../../semantic-query/semantic-query-session.ts";
import { SemanticQueryError } from "../../../semantic-query/semantic-query-service.ts";
import type { MemorySpaceTableDigest } from "../../digest.ts";

export const QUERY_SEMANTIC_SQL_TOOL_NAME = "query_semantic_sql";
const schema = Type.Object({
  sql: Type.String({ minLength: 1 }),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])),
  ),
});

/** Only QueryAgent mounts this tool; fill tools keep their existing transaction view. */
export async function createQuerySemanticSqlTool(input: {
  reader: MemorySpaceReader;
  digest: MemorySpaceTableDigest;
  query: SemanticQueryExecutor;
}): Promise<AgentTool<typeof schema>> {
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
  return {
    name: QUERY_SEMANTIC_SQL_TOOL_NAME,
    label: "语义 SQL 查询记忆",
    parameters: schema,
    description: [
      "在新的已提交快照上执行单条只读 SQLite 查询，支持 JOIN、筛选、聚合与排序。",
      "semantic_scores(table_key, groups_json, query_text) 返回 record_id、score、group_key；同一记录取所选组最高分，评分源不截取 Top K。",
      '示例：SELECT t."$display_text",s.score FROM "表Key" t JOIN semantic_scores(\'表Key\',json_array(\'组Key\'),:query) s ON s.record_id=t."$record_id" ORDER BY s.score DESC LIMIT 10。params={"query":"要搜索的内容"}。',
      "params 只接受 :name 命名参数，键不含冒号；不读取 ST 输入或宏上下文。禁止写入、事务和 PRAGMA。",
      "只搜索已有有效索引，不补建。返回索引覆盖；无有效索引与零命中应分别说明，不能据此断言记忆中不存在相关事实。",
      "每次最多返回 100 行；总等待 10 秒，累计 SQL 1 秒，最多 16 个源、4 种查询文本。相同查询向量可命中短期缓存。",
      `可用向量组及字段：${JSON.stringify(groups)}`,
    ].join("\n"),
    async execute(_id, params, signal) {
      try {
        const result = await input.query(input.digest.memorySpaceId, {
          ...params,
          signal,
          maxRows: 100,
        });
        const details = {
          columns: result.columns,
          rows: result.rows.map((row) =>
            row.map((value) =>
              typeof value === "bigint"
                ? value.toString()
                : value instanceof Uint8Array
                  ? Array.from(value)
                  : value,
            ),
          ),
          truncated: result.truncated,
          limit: 100,
          sources: result.sources.map(({ table, groups, query, coverage }) => ({
            table,
            groups,
            query,
            coverage,
          })),
          diagnostics: result.diagnostics,
        };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      } catch (error) {
        if (!(error instanceof SemanticQueryError)) throw error;
        const details = { error: error.message, diagnostics: error.diagnostics };
        // pi forwards structured tool errors to the model through a thrown Error's message.
        throw new Error(JSON.stringify(details), { cause: error });
      }
    },
  };
}
