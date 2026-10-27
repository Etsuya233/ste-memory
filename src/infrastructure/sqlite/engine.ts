import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { SemanticScoresModule } from "./semantic-scores-module.ts";
import type {
  PreparedSemanticSqlSource,
  SemanticSqlEvaluationInput,
  SemanticSqlEvaluationResult,
  SemanticSqlParams,
} from "../../features/semantic-query/semantic-sql-port.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type {
  MacroSqlEvaluationInput,
  MacroSqlResult,
} from "../../features/macros/macro-evaluation-port.ts";
import type { MemoryField, MemoryRecord, MemoryTable } from "../../features/memory/index.ts";
import type {
  SqlResultSet,
  SqlSchemaEntry,
  SqlValue,
} from "../../features/sql-console/sql-console.ts";
import type {
  SqliteConsoleResult,
  SqliteEntities,
  SqliteEntityKind,
  SqliteExecution,
  SqliteMemoryClient,
  SqliteView,
} from "./types.ts";

const sqliteIdentifierKey = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const collections = {
  table: "tables",
  field: "fields",
  record: "records",
  history: "history",
  evidence: "evidence",
} as const;
const isList = (field: MemoryField): boolean =>
  ["short_text_list", "multi_select", "multi_reference"].includes(field.type);
interface SpaceDatabase {
  write: Database;
  committed: Database;
  snapshot: MemorySpaceBackup;
  transaction: boolean;
}

/** The same engine runs in a dedicated browser Worker and in real-WASM Node tests. */
export class SqliteMemoryEngine implements SqliteMemoryClient {
  private readonly spaces = new Map<string, SpaceDatabase>();
  private readonly evaluations = new Map<
    string,
    { db: Database; semantic: SemanticScoresModule }
  >();
  private readonly consoleModules = new WeakMap<Database, SemanticScoresModule>();
  private evaluationSequence = 0;
  private readonly sqlite: Sqlite3Static;
  constructor(sqlite: Sqlite3Static) {
    this.sqlite = sqlite;
  }

  async openEvaluation(snapshot: MemorySpaceBackup): Promise<string> {
    if (snapshot.tables.some((table) => sqliteIdentifierKey(table.key) === "semantic_scores"))
      throw new Error("业务表 Key 与语义函数保留名称冲突：semantic_scores");
    const db = this.newDatabase();
    try {
      db.exec("BEGIN");
      this.store(db, "space", snapshot.space);
      for (const kind of Object.keys(collections) as (keyof typeof collections)[])
        for (const entity of snapshot[collections[kind]]) this.store(db, kind, entity);
      this.rebuild(db);
      db.exec("COMMIT");
      const id = String(++this.evaluationSequence);
      const semantic = new SemanticScoresModule(this.sqlite, db, snapshot);
      this.evaluations.set(id, { db, semantic });
      return id;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async closeEvaluation(sessionId: string): Promise<void> {
    const db = this.evaluations.get(sessionId);
    if (!db) throw new Error(`宏求值会话不存在：${sessionId}`);
    db.db.close();
    this.evaluations.delete(sessionId);
  }

  async evaluateMacro(input: MacroSqlEvaluationInput): Promise<MacroSqlResult> {
    const result = await this.executeEvaluation(input);
    if (result.status !== "complete") throw new Error("内联语义函数须通过语义 SQL 执行端口运行");
    return { columns: result.columns, rows: result.rows };
  }

  async evaluateSemanticSql(
    input: SemanticSqlEvaluationInput,
  ): Promise<SemanticSqlEvaluationResult> {
    return this.executeEvaluation({ ...input, sources: [] }, input.sources);
  }

  private async executeEvaluation(
    input: MacroSqlEvaluationInput & { params?: SemanticSqlParams; maxRows?: number },
    inlineSources?: readonly PreparedSemanticSqlSource[],
  ): Promise<SemanticSqlEvaluationResult> {
    const evaluation = this.evaluations.get(input.sessionId);
    if (!evaluation) throw new Error(`宏求值会话不存在：${input.sessionId}`);
    const { db, semantic } = evaluation;
    const started = performance.now();
    let usesSemantic = false;
    let timedResult: { elapsedMs: number } | undefined;
    const { capi, wasm } = this.sqlite;
    const totalDeadline = performance.now() + (input.remainingMs ?? Infinity);
    const businessNames = new Set(
      this.entities(db, "table").map((table) => sqliteIdentifierKey(table.key)),
    );
    const allowed = new Map(
      this.entities(db, "table")
        .filter((t) => t.enabled)
        .map((table) => [
          sqliteIdentifierKey(table.key),
          new Set([
            "$record_id",
            "$display_text",
            "$created_at",
            "$updated_at",
            ...this.entities(db, "field")
              .filter((f) => f.tableId === table.id && f.enabled)
              .map((f) => sqliteIdentifierKey(f.key)),
          ]),
        ]),
    );
    allowed.set("semantic_scores", new Set(["record_id", "score", "group_key"]));
    const created: string[] = [];
    let statement = 0;
    let source = 0;
    let statementPointer = 0;
    let tailPointer = 0;
    try {
      const names = new Set(businessNames);
      for (const relation of input.sources) {
        const name = sqliteIdentifierKey(relation.name);
        if (names.has(name) || name.startsWith("__") || name.startsWith("sqlite_"))
          throw new Error(`语义源名称冲突或使用保留名称：${relation.name}`);
        names.add(name);
        db.exec(
          `CREATE TEMP TABLE ${quote(relation.name)}(record_id TEXT NOT NULL,score REAL NOT NULL,group_key TEXT NOT NULL) STRICT`,
        );
        created.push(relation.name);
        for (const row of relation.rows) {
          if (performance.now() >= totalDeadline) throw new Error("宏求值超时");
          this.rows(db, `INSERT INTO ${quote(relation.name)} VALUES(?,?,?)`, [
            row.recordId,
            row.score,
            row.groupKey,
          ]);
        }
        allowed.set(name, new Set(["record_id", "score", "group_key"]));
      }
      // Legacy source insertion belongs to the total budget; inline retries charge all SQL work.
      const sqlStarted = inlineSources === undefined ? performance.now() : started;
      const deadline = Math.min(totalDeadline, sqlStarted + Math.min(1000, input.budgetMs ?? 1000));
      semantic.begin(inlineSources ?? [], deadline);
      const readActions = new Set<number>([
        capi.SQLITE_SELECT,
        capi.SQLITE_READ,
        capi.SQLITE_FUNCTION,
        capi.SQLITE_RECURSIVE,
      ]);
      const legacySemanticTable = created.some(
        (name) => sqliteIdentifierKey(name) === "semantic_scores",
      );
      capi.sqlite3_set_authorizer(
        db.pointer!,
        (_arg, action, tableName, columnName, databaseName) => {
          if (!readActions.has(action)) return capi.SQLITE_DENY;
          if (
            action === capi.SQLITE_FUNCTION &&
            ["load_extension", "readfile", "writefile"].includes(String(columnName))
          )
            return capi.SQLITE_DENY;
          if (action === capi.SQLITE_READ) {
            const table = sqliteIdentifierKey(String(tableName));
            // COUNT(*) can omit the schema name; the native planner disambiguates that case.
            if (
              table === "semantic_scores" &&
              !(legacySemanticTable && (databaseName === "temp" || !databaseName))
            )
              usesSemantic = true;
            if (["json_each", "json_tree"].includes(table) && !businessNames.has(table))
              return capi.SQLITE_OK;
            const columns = allowed.get(table);
            if (
              !columns ||
              (columnName !== "" && !columns.has(sqliteIdentifierKey(String(columnName))))
            )
              return capi.SQLITE_DENY;
          }
          return capi.SQLITE_OK;
        },
        0,
      );
      capi.sqlite3_progress_handler(
        db.pointer!,
        1000,
        () => (performance.now() >= deadline ? 1 : 0),
        0,
      );
      source = wasm.allocCString(input.sql, false);
      statementPointer = wasm.allocPtr(1);
      tailPointer = wasm.allocPtr(1);
      let cursor = source;
      while (wasm.heap8u()[cursor] !== 0) {
        const code = capi.sqlite3_prepare_v3(
          db.pointer!,
          cursor,
          -1,
          0,
          statementPointer,
          tailPointer,
        );
        const next = wasm.peekPtr(statementPointer);
        db.checkRc(code);
        cursor = wasm.peekPtr(tailPointer);
        if (!next) continue;
        if (statement) {
          capi.sqlite3_finalize(next);
          throw new Error("SQL 只允许一条语句");
        }
        statement = next;
      }
      if (!statement) throw new Error("SQL 需要一条查询语句");
      usesSemantic ||= semantic.planned;
      if (usesSemantic && input.sources.length)
        throw new Error("非空旧 sources 与内联 semantic_scores 不能混用");
      if (usesSemantic && inlineSources === undefined)
        throw new Error("内联语义函数须通过语义 SQL 执行端口运行");
      if (performance.now() >= deadline) throw new Error("语义 SQL 超出执行预算");
      const columns = Array.from({ length: capi.sqlite3_column_count(statement) }, (_, i) =>
        capi.sqlite3_column_name(statement, i),
      );
      if (columns.length === 0) throw new Error("SQL 必须返回查询结果");
      if (new Set(columns).size !== columns.length)
        throw new Error("SQL 返回重复列名，请使用不同别名");
      let positional = 0;
      const unused = new Set(Object.keys(input.params ?? {}));
      for (const [key, value] of Object.entries(input.params ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`SQL 参数名无效：${key}`);
        if (
          value !== null &&
          typeof value !== "string" &&
          !(typeof value === "number" && Number.isFinite(value))
        )
          throw new Error(`SQL 参数值无效：${key}`);
      }
      if (
        input.maxRows !== undefined &&
        (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1)
      )
        throw new Error("SQL 返回行数上限必须为正整数");
      for (let i = 1; i <= capi.sqlite3_bind_parameter_count(statement); i++) {
        const name = capi.sqlite3_bind_parameter_name(statement, i);
        let value: string | number | null | undefined;
        if (input.params !== undefined) {
          if (!name || !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error("语义查询只接受 :name 命名参数");
          const key = name.slice(1);
          if (!Object.hasOwn(input.params, key)) throw new Error(`SQL 缺少绑定参数：${name}`);
          unused.delete(key);
          value = input.params[key];
        } else {
          if (name && name !== ":last_user_message") throw new Error(`SQL 参数未声明：${name}`);
          value =
            name === ":last_user_message"
              ? (input.lastUserMessage ?? null)
              : input.bind?.[positional++];
        }
        if (value === undefined) throw new Error("SQL 缺少绑定参数");
        if (input.prepareOnly) continue;
        if (typeof value === "string") {
          const text = wasm.allocCString(value, false);
          try {
            db.checkRc(
              capi.sqlite3_bind_text(
                statement,
                i,
                text,
                new TextEncoder().encode(value).byteLength,
                capi.SQLITE_TRANSIENT,
              ),
            );
          } finally {
            wasm.dealloc(text);
          }
        } else
          db.checkRc(
            value === null
              ? capi.sqlite3_bind_null(statement, i)
              : capi.sqlite3_bind_double(statement, i, value),
          );
      }
      if (unused.size) throw new Error(`SQL 包含未使用参数：${[...unused].join("、")}`);
      if (input.prepareOnly) {
        const result = {
          status: "complete" as const,
          columns,
          rows: [],
          usesSemantic,
          elapsedMs: 0,
        };
        timedResult = result;
        return result;
      }
      const rows: unknown[][] = [];
      let truncated = false;
      let step: number;
      while ((step = capi.sqlite3_step(statement)) === capi.SQLITE_ROW) {
        if (input.maxRows !== undefined && rows.length === input.maxRows) {
          truncated = true;
          break;
        }
        if (rows.length === 10000) throw new Error("SQL 查询结果超过 10000 行");
        rows.push(columns.map((_, i) => capi.sqlite3_column_js(statement, i)));
      }
      if (semantic.error) throw semantic.error;
      if (semantic.pending && step === capi.SQLITE_ABORT) {
        const result = {
          status: "needs-semantic-source" as const,
          request: semantic.pending,
          elapsedMs: 0,
        };
        timedResult = result;
        return result;
      }
      if (!truncated && step !== capi.SQLITE_DONE) db.checkRc(step);
      if (performance.now() >= deadline) throw new Error("语义 SQL 超出执行预算");
      const result = {
        status: "complete" as const,
        columns,
        rows,
        usesSemantic,
        truncated,
        elapsedMs: 0,
      };
      timedResult = result;
      return result;
    } finally {
      if (statement) capi.sqlite3_finalize(statement);
      if (source) wasm.dealloc(source);
      if (statementPointer) wasm.dealloc(statementPointer);
      if (tailPointer) wasm.dealloc(tailPointer);
      capi.sqlite3_set_authorizer(db.pointer!, () => capi.SQLITE_OK, 0);
      capi.sqlite3_progress_handler(db.pointer!, 0, 0, 0);
      for (const name of created) db.exec(`DROP TABLE temp.${quote(name)}`);
      semantic.end();
      if (timedResult) timedResult.elapsedMs = performance.now() - started;
    }
  }

  /** Execute ordinary statements once, pausing at semantic reads for asynchronous preparation. */
  async executeConsole(
    spaceId: string,
    sql: string,
    lastUserMessage?: string | null,
  ): Promise<SqliteConsoleResult> {
    const db = this.database(spaceId);
    let semantic = this.consoleModules.get(db);
    if (!semantic) {
      // This module only detects native query plans. Scoring runs in the shared snapshot executor.
      semantic = new SemanticScoresModule(this.sqlite, db, this.session(spaceId).snapshot, false);
      this.consoleModules.set(db, semantic);
    }
    const { capi, wasm } = this.sqlite;
    const started = performance.now();
    const changesBefore = db.changes(true);
    const results: SqlResultSet[] = [];
    const source = wasm.allocCString(sql, false);
    const statementPointer = wasm.allocPtr(1);
    const tailPointer = wasm.allocPtr(1);
    let cursor = source;
    let semanticStatement: SqliteConsoleResult["semanticStatement"];
    try {
      // SQLite locates statement boundaries, including semicolons inside strings and trigger bodies.
      while (wasm.heap8u()[cursor] !== 0) {
        semantic.begin([], Infinity);
        const code = capi.sqlite3_prepare_v3(
          db.pointer!,
          cursor,
          -1,
          0,
          statementPointer,
          tailPointer,
        );
        const statement = wasm.peekPtr(statementPointer);
        try {
          db.checkRc(code);
          cursor = wasm.peekPtr(tailPointer);
          if (!statement) continue;
          if (semantic.planned) {
            if (!capi.sqlite3_stmt_readonly(statement))
              throw new Error("包含 semantic_scores 的语句只允许只读查询");
            semanticStatement = {
              sql: capi.sqlite3_sql(statement)!,
              remainingSql: wasm.cstrToJs(cursor)!,
            };
            break;
          }
          const contextParameter = capi.sqlite3_bind_parameter_index(
            statement,
            ":last_user_message",
          );
          if (contextParameter && lastUserMessage !== undefined && lastUserMessage !== null) {
            const text = wasm.allocCString(lastUserMessage, false);
            try {
              db.checkRc(
                capi.sqlite3_bind_text(
                  statement,
                  contextParameter,
                  text,
                  new TextEncoder().encode(lastUserMessage).byteLength,
                  capi.SQLITE_TRANSIENT,
                ),
              );
            } finally {
              wasm.dealloc(text);
            }
          }
          const columns = Array.from({ length: capi.sqlite3_column_count(statement) }, (_, index) =>
            capi.sqlite3_column_name(statement, index),
          );
          const rows: SqlValue[][] = [];
          let step: number;
          while ((step = capi.sqlite3_step(statement)) === capi.SQLITE_ROW) {
            rows.push(
              columns.map((_, index) => capi.sqlite3_column_js(statement, index) as SqlValue),
            );
          }
          if (step !== capi.SQLITE_DONE) db.checkRc(step);
          if (columns.length > 0) results.push({ columns, rows });
        } finally {
          if (statement) capi.sqlite3_finalize(statement);
          semantic.end();
        }
      }
      return {
        ...(semanticStatement ? { semanticStatement } : {}),
        results,
        changes: Number(db.changes(true)) - Number(changesBefore),
        transactionOpen: capi.sqlite3_get_autocommit(db.pointer!) === 0,
        elapsedMs: performance.now() - started,
      };
    } finally {
      wasm.dealloc(source);
      wasm.dealloc(statementPointer);
      wasm.dealloc(tailPointer);
    }
  }

  async consoleSchema(spaceId: string): Promise<readonly SqlSchemaEntry[]> {
    const db = this.database(spaceId);
    return this.rows(
      db,
      "SELECT name,type,sql FROM sqlite_schema UNION ALL SELECT name,type,sql FROM sqlite_temp_schema ORDER BY name",
    ).map((entry) => ({
      name: entry.name as string,
      type: entry.type as string,
      sql: entry.sql as string | null,
      columns: ["table", "view"].includes(entry.type as string)
        ? this.rows(db, "SELECT name,type FROM pragma_table_xinfo(?)", [entry.name as string]).map(
            (column) => ({ name: column.name as string, type: column.type as string }),
          )
        : [],
    }));
  }

  private database(spaceId: string, view: SqliteView = "committed"): Database {
    return this.session(spaceId)[view];
  }
  private session(spaceId: string): SpaceDatabase {
    const session = this.spaces.get(spaceId);
    if (!session) throw new Error(`SQLite 空间尚未初始化：${spaceId}`);
    return session;
  }
  private rows(
    db: Database,
    sql: string,
    bind: readonly (string | number | null | Uint8Array)[] = [],
  ): Record<string, unknown>[] {
    return db.exec({
      sql,
      bind: [...bind],
      rowMode: "object",
      returnValue: "resultRows",
    }) as Record<string, unknown>[];
  }
  private newDatabase(): Database {
    const db = new this.sqlite.oo1.DB(":memory:", "c");
    const decoder = new TextDecoder();
    const textAt = (pointer: number, length: number): string =>
      decoder.decode(this.sqlite.wasm.heap8u().subarray(pointer, pointer + length));
    db.checkRc(
      this.sqlite.capi.sqlite3_create_collation_v2(
        db.pointer!,
        "STE_LOCALE",
        this.sqlite.capi.SQLITE_UTF8,
        0,
        (_ctx, l1, p1, l2, p2) => textAt(p1, l1).localeCompare(textAt(p2, l2)),
        0,
      ),
    );
    db.checkRc(
      this.sqlite.capi.sqlite3_create_collation_v2(
        db.pointer!,
        "STE_UTF16",
        this.sqlite.capi.SQLITE_UTF8,
        0,
        (_ctx, l1, p1, l2, p2) => {
          const a = textAt(p1, l1),
            b = textAt(p2, l2);
          return a === b ? 0 : a < b ? -1 : 1;
        },
        0,
      ),
    );
    db.createFunction("ste_lower", (_ctx, value) =>
      value === null ? null : String(value).toLocaleLowerCase(),
    );
    db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE __entities(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(kind,id)) STRICT;",
    );
    db.createFunction("ste_text_valid", (_ctx, value, required, max, pattern) => {
      if (value === null) return required ? 0 : 1;
      const text = String(value);
      return (!required || text.trim().length > 0) &&
        (max === null || text.length <= Number(max)) &&
        (pattern === null || text.length === 0 || new RegExp(String(pattern)).test(text))
        ? 1
        : 0;
    });
    db.createFunction("ste_date_valid", (_ctx, value, datetime) => {
      if (value === null) return 1;
      const text = String(value);
      if (!(datetime ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(text))
        return 0;
      const day = text.slice(0, 10),
        date = new Date(`${day}T00:00:00.000Z`);
      if (Number.isNaN(date.valueOf()) || !date.toISOString().startsWith(day)) return 0;
      return !datetime ||
        text
          .slice(11)
          .split(":")
          .map(Number)
          .every((n, index) => n < (index === 0 ? 24 : 60))
        ? 1
        : 0;
    });
    db.createFunction("ste_list_valid", (_ctx, value, required, max, pattern) => {
      if (value === null) return required ? 0 : 1;
      const values: unknown = JSON.parse(String(value));
      if (
        !Array.isArray(values) ||
        values.some((item) => typeof item !== "string") ||
        new Set(values).size !== values.length ||
        (required && values.length === 0)
      )
        return 0;
      return values.every(
        (item: string) =>
          (max === null || item.length <= Number(max)) &&
          (pattern === null || item.length === 0 || new RegExp(String(pattern)).test(item)),
      )
        ? 1
        : 0;
    });
    return db;
  }
  async importSpace(snapshot: MemorySpaceBackup): Promise<void> {
    const db = this.newDatabase();
    try {
      db.exec("BEGIN");
      this.store(db, "space", snapshot.space);
      for (const kind of Object.keys(collections) as (keyof typeof collections)[]) {
        for (const entity of snapshot[collections[kind]]) this.store(db, kind, entity);
      }
      this.rebuild(db);
      db.exec("COMMIT");
    } catch (error) {
      db.close();
      throw error;
    }
    const old = this.spaces.get(snapshot.space.id);
    const committed = this.newDatabase();
    const session = {
      write: db,
      committed,
      snapshot: structuredClone(snapshot),
      transaction: false,
    };
    this.spaces.set(snapshot.space.id, session);
    try {
      await this.publish(snapshot.space.id);
    } catch (error) {
      db.close();
      committed.close();
      if (old) this.spaces.set(snapshot.space.id, old);
      else this.spaces.delete(snapshot.space.id);
      throw error;
    }
    old?.write.close();
    old?.committed.close();
  }
  private store(
    db: Database,
    kind: SqliteEntityKind,
    entity: SqliteEntities[SqliteEntityKind],
  ): void {
    const id = "evidence_id" in entity ? entity.evidence_id : entity.id;
    this.rows(
      db,
      "INSERT INTO __entities(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      [kind, id, JSON.stringify(entity)],
    );
  }
  private entities<K extends SqliteEntityKind>(db: Database, kind: K): SqliteEntities[K][] {
    return this.rows(db, "SELECT data FROM __entities WHERE kind=? ORDER BY rowid", [kind]).map(
      (row) => JSON.parse(row.data as string) as SqliteEntities[K],
    );
  }
  async getEntity<K extends SqliteEntityKind>(
    spaceId: string,
    kind: K,
    id: string,
    view: SqliteView = "committed",
  ): Promise<SqliteEntities[K] | undefined> {
    const row = this.rows(
      this.database(spaceId, view),
      "SELECT data FROM __entities WHERE kind=? AND id=?",
      [kind, id],
    )[0];
    return row ? (JSON.parse(row.data as string) as SqliteEntities[K]) : undefined;
  }
  async listEntities<K extends SqliteEntityKind>(
    spaceId: string,
    kind: K,
    view: SqliteView = "committed",
  ): Promise<SqliteEntities[K][]> {
    return this.entities(this.database(spaceId, view), kind);
  }
  async exportSpace(spaceId: string, view: SqliteView = "committed"): Promise<MemorySpaceBackup> {
    const session = this.session(spaceId),
      db = this.database(spaceId, view);
    return {
      ...structuredClone(session.snapshot),
      space: this.entities(db, "space")[0]!,
      tables: this.entities(db, "table"),
      fields: this.entities(db, "field"),
      records: this.entities(db, "record"),
      history: this.entities(db, "history"),
      evidence: this.entities(db, "evidence"),
    };
  }
  private schema(db: Database): { tables: MemoryTable[]; fields: MemoryField[] } {
    return { tables: this.entities(db, "table"), fields: this.entities(db, "field") };
  }
  private column(field: MemoryField, tables: MemoryTable[]): string {
    const name = quote(field.key);
    const type =
      field.type === "integer" || field.type === "boolean"
        ? "INTEGER"
        : field.type === "decimal"
          ? "REAL"
          : "TEXT";
    const checks: string[] = [];
    if (field.type === "boolean") checks.push(`${name} IN (0,1)`);
    if (isList(field))
      checks.push(
        `ste_list_valid(${name},${field.required ? 1 : 0},${field.maxChars ?? "NULL"},${field.valuePattern === null ? "NULL" : literal(field.valuePattern)})`,
      );
    if (field.type === "date" || field.type === "datetime")
      checks.push(`ste_date_valid(${name},${field.type === "datetime" ? 1 : 0})`);
    if (field.type === "single_reference") checks.push(`length(${name})>0`);
    if (["short_text", "long_text", "single_select"].includes(field.type))
      checks.push(
        `ste_text_valid(${name},${field.required ? 1 : 0},${field.maxChars ?? "NULL"},${field.valuePattern === null ? "NULL" : literal(field.valuePattern)})`,
      );
    if (field.type === "single_select")
      checks.push(`${name} IN (${field.options.map(literal).join(",")})`);
    const reference =
      field.type === "single_reference"
        ? ` REFERENCES ${quote(this.keysName(tables.find((table) => table.id === field.referenceTableId)!.id))}(id) DEFERRABLE INITIALLY DEFERRED`
        : "";
    return `${name} ${type}${field.required ? " NOT NULL" : ""}${checks.map((check) => ` CHECK(${check})`).join("")}${reference}`;
  }
  /** Metadata changes rebuild the small dynamic schema inside the caller's savepoint. */
  private rebuild(db: Database): void {
    const existing = this.rows(
      db,
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='__entities' AND substr(name,1,7)!='__keys_'",
    );
    // Defer checks while dropping/recreating mutually referencing tables.
    db.exec("PRAGMA defer_foreign_keys=ON");
    for (const row of existing) db.exec(`DROP TABLE ${quote(row.name as string)}`);
    const { tables, fields } = this.schema(db);
    // Stable ID tables keep foreign-key targets alive while editable schema is rebuilt.
    // This also permits mutually referencing table definitions and cyclic record graphs.
    for (const table of tables)
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${quote(this.keysName(table.id))}(id TEXT PRIMARY KEY NOT NULL) STRICT`,
      );
    const records = this.entities(db, "record");
    for (const record of records)
      this.rows(db, `INSERT OR IGNORE INTO ${quote(this.keysName(record.tableId))} VALUES(?)`, [
        record.id,
      ]);
    for (const table of tables) {
      const ids = records
        .filter((record) => record.tableId === table.id)
        .map((record) => record.id);
      this.rows(
        db,
        `DELETE FROM ${quote(this.keysName(table.id))} WHERE id NOT IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(ids)],
      );
    }
    for (const table of tables) {
      if (table.key.startsWith("__") || sqliteIdentifierKey(table.key).startsWith("sqlite_"))
        throw new Error(`SQLite 保留表 Key：${table.key}`);
      const columns = fields.filter((field) => field.tableId === table.id);
      if (columns.some((field) => field.key.startsWith("$") || field.key.startsWith("__")))
        throw new Error(`SQLite 保留字段 Key：${table.key}`);
      db.exec(
        `CREATE TABLE ${quote(table.key)} (${quote("$record_id")} TEXT PRIMARY KEY NOT NULL, ${quote("$display_text")} TEXT NOT NULL, ${quote("$created_at")} TEXT NOT NULL, ${quote("$updated_at")} TEXT NOT NULL${columns.map((field) => `,${this.column(field, tables)}`).join("")}) STRICT`,
      );
    }
    for (const field of fields.filter(isList)) {
      const table = tables.find((table) => table.id === field.tableId)!;
      const target =
        field.type === "multi_reference"
          ? ` CHECK(length(value)>0) REFERENCES ${quote(this.keysName(tables.find((table) => table.id === field.referenceTableId)!.id))}(id) DEFERRABLE INITIALLY DEFERRED`
          : "";
      const options =
        field.type === "multi_select"
          ? ` CHECK(value IN (${field.options.map(literal).join(",")}))`
          : "";
      db.exec(
        `CREATE TABLE ${quote(this.listName(field))}(record_id TEXT NOT NULL REFERENCES ${quote(this.keysName(table.id))}(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,position INTEGER NOT NULL,value TEXT NOT NULL${target}${options},PRIMARY KEY(record_id,position),UNIQUE(record_id,value)) STRICT`,
      );
    }
    for (const record of this.entities(db, "record")) this.writeRecord(db, record);
  }
  private listName(field: MemoryField): string {
    return `__list_${field.id}`;
  }
  private keysName(tableId: string): string {
    return `__keys_${tableId}`;
  }
  private writeRecord(db: Database, record: MemoryRecord): void {
    const { tables, fields } = this.schema(db),
      table = tables.find((table) => table.id === record.tableId);
    if (!table) throw new Error(`记录的表不存在：${record.tableId}`);
    this.rows(db, `INSERT OR IGNORE INTO ${quote(this.keysName(table.id))} VALUES(?)`, [record.id]);
    const columns = fields.filter((field) => field.tableId === table.id);
    const names = [
      "$record_id",
      "$display_text",
      "$created_at",
      "$updated_at",
      ...columns.map((field) => field.key),
    ];
    const values = [
      record.id,
      record.displayText,
      record.createdAt,
      record.updatedAt,
      ...columns.map((field) => {
        const value = record.payload[field.id] ?? null;
        return isList(field) && value !== null
          ? JSON.stringify(value)
          : typeof value === "boolean"
            ? Number(value)
            : value;
      }),
    ] as (string | number | null)[];
    this.rows(
      db,
      `INSERT INTO ${quote(table.key)}(${names.map(quote).join(",")}) VALUES(${names.map(() => "?").join(",")}) ON CONFLICT(${quote("$record_id")}) DO UPDATE SET ${names
        .slice(1)
        .map((name) => `${quote(name)}=excluded.${quote(name)}`)
        .join(",")}`,
      values,
    );
    for (const field of columns.filter(isList)) {
      this.rows(db, `DELETE FROM ${quote(this.listName(field))} WHERE record_id=?`, [record.id]);
      const values = record.payload[field.id];
      if (values !== null && values !== undefined) {
        for (const [position, value] of (values as readonly string[]).entries())
          this.rows(db, `INSERT INTO ${quote(this.listName(field))} VALUES(?,?,?)`, [
            record.id,
            position,
            value,
          ]);
      }
    }
  }
  private async mutation(spaceId: string, action: (db: Database) => void): Promise<void> {
    const session = this.session(spaceId),
      own = !session.transaction;
    if (own) await this.begin(spaceId);
    session.write.exec("SAVEPOINT __entity_write");
    try {
      action(session.write);
      session.write.exec("RELEASE __entity_write");
      if (own) await this.commit(spaceId);
    } catch (error) {
      if (this.sqlite.capi.sqlite3_get_autocommit(session.write.pointer!) === 0) {
        if (own) await this.rollback(spaceId);
        else session.write.exec("ROLLBACK TO __entity_write; RELEASE __entity_write");
      } else session.transaction = false;
      throw error;
    }
  }
  async putEntity<K extends SqliteEntityKind>(
    spaceId: string,
    kind: K,
    entity: SqliteEntities[K],
  ): Promise<void> {
    await this.mutation(spaceId, (db) => {
      this.store(db, kind, entity);
      if (kind === "record") this.writeRecord(db, entity as MemoryRecord);
      else if (kind === "table" || kind === "field") this.rebuild(db);
    });
  }
  async deleteEntity(spaceId: string, kind: SqliteEntityKind, id: string): Promise<void> {
    await this.mutation(spaceId, (db) => {
      if (kind === "record") {
        const record = this.entities(db, "record").find((record) => record.id === id);
        if (record) {
          const table = this.entities(db, "table").find((table) => table.id === record.tableId)!;
          this.rows(db, `DELETE FROM ${quote(table.key)} WHERE ${quote("$record_id")}=?`, [id]);
          this.rows(db, `DELETE FROM ${quote(this.keysName(table.id))} WHERE id=?`, [id]);
        }
      }
      this.rows(db, "DELETE FROM __entities WHERE kind=? AND id=?", [kind, id]);
      if (kind === "table" || kind === "field") this.rebuild(db);
    });
  }
  async begin(spaceId: string): Promise<void> {
    const session = this.session(spaceId);
    session.write.exec("BEGIN");
    session.transaction = true;
  }
  async commit(spaceId: string): Promise<void> {
    const session = this.session(spaceId);
    const missing = this.rows(session.write, "PRAGMA foreign_key_check");
    if (missing.length) throw new Error("记忆引用约束未满足");
    session.write.exec("COMMIT");
    session.transaction = false;
    await this.publish(spaceId);
  }
  async rollback(spaceId: string): Promise<void> {
    const session = this.session(spaceId);
    session.write.exec("ROLLBACK");
    session.transaction = false;
  }
  async savepoint(spaceId: string, name: string): Promise<void> {
    this.database(spaceId, "write").exec(`SAVEPOINT ${quote(name)}`);
  }
  async release(spaceId: string, name: string): Promise<void> {
    this.database(spaceId, "write").exec(`RELEASE ${quote(name)}`);
  }
  async rollbackTo(spaceId: string, name: string): Promise<void> {
    this.database(spaceId, "write").exec(`ROLLBACK TO ${quote(name)}`);
  }
  async publish(spaceId: string): Promise<void> {
    const session = this.session(spaceId);
    if (session.transaction) throw new Error("不能发布尚未提交的 SQLite 数据");
    const db = this.newDatabase();
    try {
      db.exec("BEGIN");
      for (const row of this.rows(session.write, "SELECT kind,id,data FROM __entities"))
        this.rows(db, "INSERT INTO __entities VALUES(?,?,?)", [
          row.kind as string,
          row.id as string,
          row.data as string,
        ]);
      this.rebuild(db);
      db.exec("COMMIT");
    } catch (error) {
      db.close();
      throw error;
    }
    session.committed.close();
    session.committed = db;
  }
  async exec(input: SqliteExecution): Promise<Record<string, unknown>[]> {
    const {
      spaceId,
      sql,
      bind = [],
      view = "committed",
      access = "read",
      budgetMs = 1000,
      maxRows,
      allowedTables,
    } = input;
    const db = this.database(spaceId, view),
      capi = this.sqlite.capi;
    if (access === "write")
      throw new Error("业务写入须通过记忆操作端口，以维护修订、证据和字段关系");
    const deadline = performance.now() + budgetMs;
    const jsonVirtualTables = new Set(
      ["json_each", "json_tree"].filter(
        (name) =>
          !this.entities(db, "table").some((table) => sqliteIdentifierKey(table.key) === name),
      ),
    );
    const readActions = new Set<number>([
      capi.SQLITE_SELECT,
      capi.SQLITE_READ,
      capi.SQLITE_FUNCTION,
      capi.SQLITE_RECURSIVE,
    ]);
    // SQLite's compile-time authorizer rejects transaction control, PRAGMA, DDL and DML.
    capi.sqlite3_set_authorizer(
      db.pointer!,
      (_arg, action, tableName, functionName) => {
        if (access === "host") return capi.SQLITE_OK;
        if (
          action === capi.SQLITE_READ &&
          allowedTables !== undefined &&
          !jsonVirtualTables.has(String(tableName))
        ) {
          const columns = allowedTables[String(tableName)];
          if (!columns || (functionName !== "" && !columns.includes(String(functionName))))
            return capi.SQLITE_DENY;
        }
        if (
          action === capi.SQLITE_FUNCTION &&
          ["load_extension", "writefile", "readfile"].includes(String(functionName))
        )
          return capi.SQLITE_DENY;
        return readActions.has(action) ? capi.SQLITE_OK : capi.SQLITE_DENY;
      },
      0,
    );
    capi.sqlite3_progress_handler(
      db.pointer!,
      1000,
      () => (performance.now() > deadline ? 1 : 0),
      0,
    );
    try {
      if (maxRows === undefined) return this.rows(db, sql, bind);
      const rows: Record<string, unknown>[] = [];
      db.exec({
        sql,
        bind: [...bind],
        rowMode: "object",
        callback(row) {
          rows.push(row as Record<string, unknown>);
          if (rows.length >= maxRows) return false;
        },
      });
      return rows;
    } finally {
      capi.sqlite3_set_authorizer(db.pointer!, () => capi.SQLITE_OK, 0);
      capi.sqlite3_progress_handler(db.pointer!, 0, 0, 0);
    }
  }
  async removeSpace(spaceId: string): Promise<void> {
    const session = this.session(spaceId);
    session.write.close();
    session.committed.close();
    this.spaces.delete(spaceId);
  }
  async close(): Promise<void> {
    for (const sessionId of this.evaluations.keys()) await this.closeEvaluation(sessionId);
    for (const spaceId of this.spaces.keys()) await this.removeSpace(spaceId);
  }
}
