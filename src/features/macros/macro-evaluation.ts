import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import {
  compileMemoryQueryConditions,
  createReadTimeDisplayTextResolver,
  effectiveVectorIndexGroups,
  MemoryRecordQueryService,
  type MemoryField,
  type MemoryRecord,
  type QueryRecordFieldId,
  type QueryRecordsInput,
} from "../memory/index.ts";
import type {
  VectorEmbeddingPort,
  VectorIndexRepository,
  RecordVector,
} from "../vector-index/index.ts";
import type { MacroExpression, MacroSemanticSource, MacroQuery } from "./macro-expression.ts";
import type {
  MacroSqlEvaluationPort,
  MacroSqlResult,
  MacroScoreRow,
} from "./macro-evaluation-port.ts";

export interface MacroSemanticResult {
  readonly name: string;
  readonly table: string;
  readonly groups: readonly string[];
  readonly coverage: {
    records: number;
    expected: number;
    ready: number;
    empty: number;
    missing: number;
    stale: number;
    invalid: number;
  };
  readonly rows: readonly MacroScoreRow[];
  readonly calls: number;
}
export interface MacroEvaluationResult extends MacroSqlResult {
  readonly sources: readonly MacroSemanticResult[];
}
export interface MacroEvaluationBatch {
  evaluate(expression: MacroExpression): Promise<MacroEvaluationResult>;
  validate(expression: MacroExpression): Promise<void>;
  close(): Promise<void>;
}
export interface MacroEvaluationBatchInput {
  readonly sql: MacroSqlEvaluationPort;
  readonly vectors: Pick<VectorIndexRepository, "listVectors">;
  readonly embedding: VectorEmbeddingPort;
  readonly snapshot: MemorySpaceBackup;
  readonly lastUserMessage: string | null;
  readonly signal: AbortSignal;
  /** performance.now() clock, shared by all phases of this batch. */
  readonly deadline: number;
}
const sqliteIdentifierKey = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
function norm(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum = Math.hypot(sum, value);
  return sum;
}
function valid(values: readonly number[]): boolean {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every(Number.isFinite) &&
    norm(values) > 0 &&
    Number.isFinite(norm(values))
  );
}

/** A batch owns one immutable memory snapshot, connection profile and query-vector cache. */
export async function createMacroEvaluationBatch(
  input: MacroEvaluationBatchInput,
): Promise<MacroEvaluationBatch> {
  const { sql, vectors, embedding, signal, deadline, lastUserMessage } = input;
  let snapshot = structuredClone(input.snapshot);
  const profile = structuredClone(embedding.getProfile());
  let closed = false;
  const check = () => {
    signal.throwIfAborted();
    if (closed) throw new DOMException("宏求值会话已关闭", "AbortError");
    if (performance.now() >= deadline) throw new DOMException("宏求值超时", "TimeoutError");
  };
  const yieldExecution = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    check();
  };
  check();
  const display = createReadTimeDisplayTextResolver({
    getTable: async (id) => snapshot.tables.find((table) => table.id === id),
    getFields: async (id) => snapshot.fields.filter((field) => field.tableId === id),
    findRecord: async (tableId, id) =>
      snapshot.records.find((record) => record.tableId === tableId && record.id === id),
  });
  const fresh: MemoryRecord[] = [];
  for (let i = 0; i < snapshot.records.length; i++) {
    if (i % 100 === 0) await yieldExecution();
    const record = snapshot.records[i]!;
    fresh.push({ ...record, displayText: await display(record) });
  }
  snapshot = { ...snapshot, records: fresh };
  check();
  const opening = sql.openEvaluation(snapshot);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closing) {
      closed = true;
      signal.removeEventListener("abort", aborted);
      closing = opening.then((id) => sql.closeEvaluation(id));
    }
    return closing;
  };
  const aborted = () => {
    void close();
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();
  let sessionId: string;
  try {
    sessionId = await opening;
    check();
  } catch (error) {
    await close();
    throw error;
  }
  let querySourceName = "macro_scores";
  while (snapshot.tables.some((table) => sqliteIdentifierKey(table.key) === querySourceName))
    querySourceName += "_";
  const embeddings = new Map<string, Promise<readonly number[]>>();
  const scores = new Map<string, Promise<MacroSemanticResult>>();
  const stored = new Map<string, Promise<RecordVector[]>>();
  const sourceResult = (source: MacroSemanticSource): Promise<MacroSemanticResult> => {
    const key = JSON.stringify([source.table, source.groups, source.query]);
    const created = !scores.has(key);
    if (created) scores.set(key, scoreSource(source));
    return scores
      .get(key)!
      .then((result) => ({ ...result, name: source.name, calls: created ? result.calls : 0 }));
  };
  function sourceMetadata(source: MacroSemanticSource) {
    const table = snapshot.tables.find((table) => table.key === source.table && table.enabled);
    if (!table) throw new Error(`语义源的表不存在或已停用：${source.table}`);
    if (!table.vectorIndex?.enabled) throw new Error(`表未启用向量索引：${source.table}`);
    const fields = snapshot.fields.filter((field) => field.tableId === table.id);
    const groups = effectiveVectorIndexGroups(table.vectorIndex, fields);
    const selected = source.groups.map((key) => {
      const group = groups.find((group) => group.key === key);
      if (
        !group ||
        !group.fieldIds.length ||
        group.fieldIds.some((id) => !fields.some((field) => field.id === id && field.enabled))
      )
        throw new Error(`语义源分组不存在或字段无效：${source.table}/${key}`);
      return group;
    });
    if (!selected.length) throw new Error("语义源至少需要一个分组");
    return { table, fields, selected };
  }
  async function scoreSource(source: MacroSemanticSource): Promise<MacroSemanticResult> {
    check();
    const { table, fields, selected } = sourceMetadata(source);
    const query = ("text" in source.query ? source.query.text : lastUserMessage)?.trim();
    if (!query) throw new Error("语义查询文本为空或缺少最后用户消息");
    if (query.length > 4000) throw new Error("语义查询文本超过 4000 字符");
    const records = snapshot.records.filter((record) => record.tableId === table.id);
    const coverage = {
      records: records.length,
      expected: 0,
      ready: 0,
      empty: 0,
      missing: 0,
      stale: 0,
      invalid: 0,
    };
    const result: MacroSemanticResult = {
      name: source.name,
      table: source.table,
      groups: source.groups,
      coverage,
      rows: [],
      calls: 0,
    };
    if (!records.length) return result;
    if (!stored.has(table.id))
      stored.set(
        table.id,
        vectors.listVectors({ memorySpaceId: snapshot.space.id, tableId: table.id }),
      );
    const recordIds = new Set(records.map((record) => record.id));
    const groupIds = new Set(selected.map((group) => group.id));
    const raw = (await stored.get(table.id)!).filter(
      (vector) => groupIds.has(vector.groupId) && recordIds.has(vector.recordId),
    );
    check();
    if (raw.length && !profile) throw new Error("已有存储向量，但尚未配置 embedding 连接");
    if (raw.length && profile && query.length > profile.maxInputChars)
      throw new Error("语义查询文本超过连接输入限制");
    const byTarget = new Map(
      raw.map((vector) => [JSON.stringify([vector.recordId, vector.groupId]), vector]),
    );
    const candidates: { record: MemoryRecord; groupKey: string; vector: RecordVector }[] = [];
    for (let i = 0; i < records.length; i++) {
      if (i % 100 === 0) await yieldExecution();
      const record = records[i]!;
      for (const group of selected) {
        const lines: string[] = [];
        let brokenReference = false;
        for (const id of group.fieldIds) {
          const field = fields.find((field) => field.id === id)!;
          const value = record.payload[id];
          if (
            value === null ||
            value === undefined ||
            value === "" ||
            (Array.isArray(value) && !value.length)
          )
            continue;
          let text: string;
          if (field.type === "single_reference" || field.type === "multi_reference") {
            const ids = Array.isArray(value) ? value : [String(value)];
            const refs = ids.map((id) =>
              snapshot.records.find(
                (record) => record.tableId === field.referenceTableId && record.id === id,
              ),
            );
            if (refs.some((ref) => !ref)) {
              brokenReference = true;
              break;
            }
            text = refs.map((ref) => ref!.displayText).join("、");
          } else text = Array.isArray(value) ? value.join("、") : String(value);
          if (text) lines.push(`${field.name}：${text}`);
        }
        const text = lines.join("\n");
        if (!text && !brokenReference) {
          coverage.empty++;
          continue;
        }
        coverage.expected++;
        const vector = byTarget.get(JSON.stringify([record.id, group.id]));
        if (brokenReference || (profile && text.length > profile.maxInputChars)) coverage.invalid++;
        else if (!vector) coverage.missing++;
        else if (
          vector.fingerprint !==
            JSON.stringify([group.fieldIds, text, profile!.model, profile!.version]) ||
          vector.model !== profile!.model ||
          vector.version !== profile!.version
        )
          coverage.stale++;
        else if (
          !valid(vector.values) ||
          (profile!.dimensions !== undefined && vector.values.length !== profile!.dimensions)
        )
          coverage.invalid++;
        else {
          coverage.ready++;
          candidates.push({ record, groupKey: group.key, vector });
        }
      }
    }
    if (!candidates.length) return result;
    if (embedding.getProfile()?.version !== profile!.version)
      throw new Error("embedding 连接已变更");
    const embeddingKey = JSON.stringify([
      profile!.model,
      profile!.version,
      profile!.dimensions,
      query,
    ]);
    const requested = !embeddings.has(embeddingKey);
    if (requested) embeddings.set(embeddingKey, embedding.embed(query, signal));
    const queryVector = await embeddings.get(embeddingKey)!;
    if (embedding.getProfile()?.version !== profile!.version)
      throw new Error("embedding 连接已变更");
    check();
    if (
      !valid(queryVector) ||
      (profile!.dimensions !== undefined && queryVector.length !== profile!.dimensions)
    )
      throw new Error("查询向量维度或数值异常");
    const queryNorm = norm(queryVector);
    const rows = new Map<string, MacroScoreRow>();
    for (let i = 0; i < candidates.length; i++) {
      if (i % 100 === 0) await yieldExecution();
      const { record, groupKey, vector } = candidates[i]!;
      if (vector.values.length !== queryVector.length) {
        coverage.ready--;
        coverage.invalid++;
        continue;
      }
      const vectorNorm = norm(vector.values);
      let score = 0;
      for (let j = 0; j < queryVector.length; j++) {
        if (j > 0 && j % 16384 === 0) await yieldExecution();
        score += (queryVector[j]! / queryNorm) * (vector.values[j]! / vectorNorm);
      }
      score = Math.max(-1, Math.min(1, score));
      const old = rows.get(record.id);
      if (!old || score > old.score || (score === old.score && groupKey < old.groupKey))
        rows.set(record.id, { recordId: record.id, score, groupKey });
    }
    return { ...result, rows: [...rows.values()], calls: Number(requested) };
  }
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
      sourceMetadata(source);
    }
    return declarations;
  }
  return {
    async validate(expression) {
      check();
      const declarations = expressionSources(expression);
      const query = expression.language === "query" ? compile(expression.query) : null;
      await sql.evaluateMacro({
        sessionId,
        sql: query?.sql ?? (expression as { sql: string }).sql,
        ...(query ? { bind: query.bind } : {}),
        sources: declarations.map((source) => ({ name: source.name, rows: [] })),
        prepareOnly: true,
        remainingMs: deadline - performance.now(),
      });
      check();
    },
    async evaluate(expression) {
      check();
      const declarations = expressionSources(expression);
      const query = expression.language === "query" ? compile(expression.query) : null;
      const sources = await Promise.all(declarations.map(sourceResult));
      check();
      const result = await sql.evaluateMacro({
        sessionId,
        sql: query?.sql ?? (expression as { sql: string }).sql,
        ...(query ? { bind: query.bind } : {}),
        lastUserMessage,
        sources,
        budgetMs: 1000,
        remainingMs: deadline - performance.now(),
      });
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
