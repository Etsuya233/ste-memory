import {
  createSemanticQuerySession,
  type SemanticSqlProgress,
} from "../semantic-query/semantic-query-session.ts";
import { type SemanticScoreResult } from "../semantic-query/semantic-scores.ts";
import type { QueryVectorExecution } from "../semantic-query/query-vector-cache.ts";
import type { SemanticSqlEvaluationPort } from "../semantic-query/semantic-sql-port.ts";
import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import {
  compileMemoryQueryConditions,
  MemoryRecordQueryService,
  type MemoryField,
  type QueryRecordFieldId,
  type QueryRecordsInput,
} from "../memory/index.ts";
import type { VectorEmbeddingPort, VectorIndexRepository } from "../vector-index/index.ts";
import type { MacroExpression, MacroSemanticSource, MacroQuery } from "./macro-expression.ts";
import type { MacroSqlEvaluationPort, MacroSqlResult } from "./macro-evaluation-port.ts";

export interface MacroSemanticResult extends SemanticScoreResult {
  readonly name: string;
}
export interface MacroEvaluationResult extends MacroSqlResult {
  readonly sources: readonly MacroSemanticResult[];
  readonly execution?: { readonly sqlPasses: number; readonly sqlMs: number };
}
export interface MacroEvaluationBatch {
  evaluate(expression: MacroExpression): Promise<MacroEvaluationResult>;
  validate(expression: MacroExpression): Promise<boolean>;
  statistics(expression: MacroExpression): MacroEvaluationStatistics;
  close(): Promise<void>;
}
export interface MacroEvaluationStatistics {
  readonly sqlPasses?: number;
  readonly sqlMs?: number;
  readonly preparedSources?: number;
  readonly queryTexts?: number;
  readonly queryVectorScope: "batch";
  readonly queryVectors: ReturnType<QueryVectorExecution["stats"]>;
  readonly cleanupError?: string;
}
export interface MacroEvaluationBatchInput {
  readonly sql: MacroSqlEvaluationPort & SemanticSqlEvaluationPort;
  readonly queryVectors: QueryVectorExecution;
  readonly vectors: Pick<VectorIndexRepository, "listVectors">;
  readonly embedding: VectorEmbeddingPort;
  readonly snapshot: MemorySpaceBackup;
  readonly lastUserMessage: string | null;
  readonly signal: AbortSignal;
  /** performance.now() clock, shared by all phases of this batch. */
  readonly deadline: number;
  readonly onCleanupError?: (error: unknown) => void;
}
const sqliteIdentifierKey = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
/** A batch owns one immutable memory snapshot, connection profile and query-vector cache. */
export async function createMacroEvaluationBatch(
  input: MacroEvaluationBatchInput,
): Promise<MacroEvaluationBatch> {
  const { sql, deadline, lastUserMessage } = input;
  const session = await createSemanticQuerySession(input);
  const { snapshot, sessionId, scoring, check, close } = session;
  const executions = new WeakMap<MacroExpression, SemanticSqlProgress>();
  let querySourceName = "macro_scores";
  while (snapshot.tables.some((table) => sqliteIdentifierKey(table.key) === querySourceName))
    querySourceName += "_";
  const sourceResult = async (source: MacroSemanticSource): Promise<MacroSemanticResult> => ({
    ...(await scoring.get({
      table: source.table,
      groups: source.groups,
      query: ("text" in source.query ? source.query.text : lastUserMessage) ?? "",
    })),
    name: source.name,
  });
  function compile(query: MacroQuery) {
    const table = snapshot.tables.find((table) => table.key === query.table && table.enabled);
    if (!table) throw new Error(`查询表不存在或已停用：${query.table}`);
    const fields = snapshot.fields.filter((field) => field.tableId === table.id && field.enabled);
    const field = (key: string): string => {
      if (key.startsWith("$")) {
        if (
          ![
            "$record_id",
            "$display_text",
            "$created_at",
            "$updated_at",
            ...(query.semantic ? ["$similarity"] : []),
          ].includes(key)
        )
          throw new Error(`查询系统字段无效：${key}`);
        return key;
      }
      const found = fields.find((field) => field.key === key);
      if (!found) throw new Error(`查询字段不存在或已停用：${key}`);
      return found.id;
    };
    const conditions = (query.conditions ?? []).map((condition) => ({
      fieldId: field(condition.field) as QueryRecordFieldId,
      operator: condition.op,
      value: condition.value,
    }));
    const similarity = conditions.filter((condition) => condition.fieldId === "$similarity");
    for (const condition of similarity)
      if (
        ![
          "equals",
          "not_equals",
          "greater_than",
          "greater_than_or_equal",
          "less_than",
          "less_than_or_equal",
        ].includes(condition.operator) ||
        !(
          (condition.value === null && ["equals", "not_equals"].includes(condition.operator)) ||
          (typeof condition.value === "number" && Number.isFinite(condition.value))
        )
      )
        throw new Error("$similarity 条件需要数值比较");
    const order = query.orderBy
      ? {
          fieldId: field(query.orderBy.field) as QueryRecordFieldId,
          direction: query.orderBy.direction,
        }
      : { fieldId: "$updated_at" as const, direction: "desc" as const };
    const definition: QueryRecordsInput = {
      tableId: table.id,
      conditions: conditions.filter((condition) => condition.fieldId !== "$similarity"),
      paging: { page: 1, pageSize: 100 },
      ...(order.fieldId === "$similarity" ? {} : { order }),
    };
    MemoryRecordQueryService.validateDefinition(definition, fields);
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1))
      throw new Error("宏 Query limit 必须是正整数");
    const byId = new Map(fields.map((field) => [field.id as string, field]));
    const column = (id: string) =>
      id === "$similarity" ? `s.score` : `t.${quote(id.startsWith("$") ? id : byId.get(id)!.key)}`;
    const bind: (string | number | null)[] = [];
    const predicates = compileMemoryQueryConditions(conditions, byId, column, (value) => {
      bind.push(typeof value === "boolean" ? Number(value) : (value as string | number | null));
      return "?";
    });
    const selected = query.fields?.map((key) => {
      field(key);
      return key;
    }) ?? ["$display_text"];
    if (!selected.length) throw new Error("宏 Query fields 不能为空数组");
    const columns = selected.map((key) =>
      key.startsWith("$") ? key : fields.find((field) => field.key === key)!.name,
    );
    if (new Set(columns).size !== columns.length) throw new Error("宏 Query 输出列名重复");
    const projection = selected
      .map((key, i) => `${column(field(key))} AS ${quote(columns[i]!)}`)
      .join(",");
    return {
      sql: `SELECT ${projection} FROM ${quote(table.key)} t${query.semantic ? ` INNER JOIN ${quote(querySourceName)} s ON s.record_id=t."$record_id"` : ""}${predicates.length ? ` WHERE ${predicates.join(" AND ")}` : ""} ORDER BY ${column(order.fieldId)} COLLATE STE_UTF16 ${order.direction.toUpperCase()},t."$record_id" COLLATE STE_LOCALE ASC${query.limit === undefined ? "" : ` LIMIT ${query.limit}`}`,
      bind,
      selected,
      fields,
    };
  }
  function expressionSources(expression: MacroExpression) {
    const declarations: readonly MacroSemanticSource[] =
      expression.language === "sql"
        ? (expression.sources ?? [])
        : expression.query.semantic
          ? [
              {
                name: querySourceName,
                table: expression.query.table,
                ...expression.query.semantic,
              },
            ]
          : [];
    const names = new Set(snapshot.tables.map((table) => sqliteIdentifierKey(table.key)));
    for (const source of declarations) {
      const name = sqliteIdentifierKey(source.name);
      if (!name.trim() || names.has(name) || name.startsWith("__") || name.startsWith("sqlite_"))
        throw new Error(`语义源名称冲突：${source.name}`);
      names.add(name);
      scoring.validate(source);
    }
    return declarations;
  }
  return {
    statistics: (expression) => ({
      ...executions.get(expression),
      ...session.statistics(),
    }),
    async validate(expression) {
      check();
      const declarations = expressionSources(expression);
      const query = expression.language === "query" ? compile(expression.query) : null;
      if (expression.language === "sql" && !declarations.length) {
        const result = await sql.evaluateSemanticSql({
          sessionId,
          sql: expression.sql,
          sources: [],
          prepareOnly: true,
          remainingMs: deadline - performance.now(),
        });
        check();
        if (result.status !== "complete") throw new Error("SQL 编译期间不能请求准备评分源");
        return result.usesSemantic;
      }
      await sql.evaluateMacro({
        sessionId,
        sql: query?.sql ?? (expression as { sql: string }).sql,
        ...(query ? { bind: query.bind } : {}),
        sources: declarations.map((source) => ({ name: source.name, rows: [] })),
        prepareOnly: true,
        remainingMs: deadline - performance.now(),
      });
      check();
      return declarations.length > 0;
    },
    async evaluate(expression) {
      const progress = { sqlPasses: 0, sqlMs: 0, preparedSources: 0, queryTexts: 0 };
      executions.set(expression, progress);
      check();
      const declarations = expressionSources(expression);
      const query = expression.language === "query" ? compile(expression.query) : null;
      if (expression.language === "sql" && !declarations.length)
        return session.evaluate(expression.sql, { progress });
      if (expression.language === "sql") {
        await sql.evaluateMacro({
          sessionId,
          sql: expression.sql,
          sources: declarations.map((source) => ({ name: source.name, rows: [] })),
          prepareOnly: true,
          remainingMs: deadline - performance.now(),
        });
        check();
      }
      const sources = await Promise.all(
        declarations.map(async (source) => {
          const result = await sourceResult(source);
          progress.preparedSources++;
          return result;
        }),
      );
      progress.queryTexts = new Set(sources.map((source) => source.query)).size;
      check();
      const sqlStarted = performance.now();
      progress.sqlPasses = 1;
      const result = await sql.evaluateMacro({
        sessionId,
        sql: query?.sql ?? (expression as { sql: string }).sql,
        ...(query ? { bind: query.bind } : {}),
        lastUserMessage,
        sources,
        budgetMs: 1000,
        remainingMs: deadline - performance.now(),
      });
      progress.sqlMs = performance.now() - sqlStarted;
      check();
      if (!query) return { ...result, sources };
      const rows = result.rows.map((row) =>
        row.map((value, index) => {
          const field: MemoryField | undefined = query.fields.find(
            (field) => field.key === query.selected[index],
          );
          if (!field || value === null) return value;
          if (field.type === "boolean") return Boolean(value);
          const list = ["multi_reference", "short_text_list", "multi_select"].includes(field.type);
          const values = list ? (JSON.parse(value as string) as string[]) : [value as string];
          if (field.type === "single_reference" || field.type === "multi_reference") {
            const names = values.map(
              (id) =>
                snapshot.records.find(
                  (record) => record.tableId === field.referenceTableId && record.id === id,
                )?.displayText ?? "",
            );
            return list ? names : names[0];
          }
          return list ? values : value;
        }),
      );
      return { ...result, rows, sources };
    },
    close,
  };
}
