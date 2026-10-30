import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type {
  MemoryDatabaseQueryInput,
  MemoryDatabaseQueryResult,
  MemoryDatabaseSchema,
  MemoryRegisterViewsInput,
  MemorySqlScalar,
  MemorySqlView,
} from "../../features/public-read/database-api.ts";

const key = (name: string): string => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const systemColumns = ["$record_id", "$display_text", "$created_at", "$updated_at"];
const maxValueBytes = 1024 * 1024;
const maxResultBytes = 2 * 1024 * 1024;
interface Registration {
  schemaKey: string;
  views: readonly MemorySqlView[];
  columns: Map<string, readonly string[]>;
  ready: boolean;
}

/** Transient view ownership and bounded native SQL on the existing committed database. */
export class PublicSqlDatabase {
  readonly #sqlite: Sqlite3Static;
  readonly #spaces = new Map<string, Map<string, Registration>>();

  constructor(sqlite: Sqlite3Static) {
    this.#sqlite = sqlite;
  }

  static schema(input: Omit<MemoryDatabaseSchema, "schemaKey" | "columns">): MemoryDatabaseSchema {
    const tables = input.tables.filter((table) => table.enabled);
    const ids = new Set(tables.map((table) => table.id));
    const fields = input.fields.filter((field) => field.enabled && ids.has(field.tableId));
    const columns = Object.fromEntries(
      tables.map((table) => [
        table.key,
        [
          ...systemColumns,
          ...fields.filter((field) => field.tableId === table.id).map((field) => field.key),
        ],
      ]),
    );
    // Preserve the actual structural identity, including labels, references and display strategy.
    // Timestamps and space updates also change for ordinary record commits and are excluded.
    const schemaKey = JSON.stringify([
      { id: input.space.id, name: input.space.name },
      tables.map((table) =>
        Object.fromEntries(
          Object.entries(table).filter(([name]) => name !== "createdAt" && name !== "updatedAt"),
        ),
      ),
      fields.map((field) =>
        Object.fromEntries(
          Object.entries(field).filter(([name]) => name !== "createdAt" && name !== "updatedAt"),
        ),
      ),
    ]);
    return {
      databaseKey: input.databaseKey,
      space: input.space,
      tables,
      fields,
      columns,
      schemaKey,
    };
  }

  register(db: Database, schema: MemoryDatabaseSchema, input: MemoryRegisterViewsInput): void {
    this.#assertSchema(schema, input.schemaKey);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.namespace))
      throw new Error("SQL 视图 namespace 无效");
    let namespaces = this.#spaces.get(input.spaceId);
    if (!namespaces) this.#spaces.set(input.spaceId, (namespaces = new Map()));
    const namespace = key(input.namespace);
    const old = namespaces.get(namespace);
    const ownViews = new Set(old?.ready ? old.views.map((view) => key(view.name)) : []);
    const occupied = new Set(
      db
        .selectArrays(
          "SELECT name FROM main.sqlite_schema UNION ALL SELECT name FROM temp.sqlite_schema",
        )
        .map((row) => key(String(row[0])))
        .filter((name) => !ownViews.has(name)),
    );
    for (const [owner, registration] of namespaces)
      if (owner !== namespace) for (const view of registration.views) occupied.add(key(view.name));
    for (const view of input.views) {
      if (
        !view.name ||
        view.name.length > 256 ||
        view.name.includes("\0") ||
        key(view.name).startsWith("sqlite_") ||
        view.name.startsWith("__")
      )
        throw new Error(`SQL 视图名称无效或保留：${view.name}`);
      if (occupied.has(key(view.name))) throw new Error(`SQL 视图名称冲突：${view.name}`);
      occupied.add(key(view.name));
    }
    const registration: Registration = {
      schemaKey: schema.schemaKey,
      views: structuredClone(input.views),
      columns: new Map(),
      ready: false,
    };
    db.exec("SAVEPOINT public_views");
    try {
      if (old?.ready)
        for (const view of [...old.views].reverse()) db.exec(`DROP VIEW temp.${quote(view.name)}`);
      this.#install(db, schema, registration);
      db.exec("RELEASE public_views");
      namespaces.set(namespace, registration);
    } catch (error) {
      db.exec("ROLLBACK TO public_views");
      db.exec("RELEASE public_views");
      throw error;
    }
  }

  /** Publishing must succeed even when a consumer's old mappings no longer compile. */
  published(db: Database, schema: MemoryDatabaseSchema): void {
    for (const registration of this.#spaces.get(schema.space.id)?.values() ?? []) {
      registration.ready = false;
      registration.columns.clear();
      if (registration.schemaKey !== schema.schemaKey) continue;
      db.exec("SAVEPOINT public_views");
      try {
        this.#install(db, schema, registration);
        db.exec("RELEASE public_views");
      } catch {
        db.exec("ROLLBACK TO public_views");
        db.exec("RELEASE public_views");
        registration.ready = false;
        registration.columns.clear();
      }
    }
  }

  remove(spaceId: string): void {
    this.#spaces.delete(spaceId);
  }

  query(
    db: Database,
    schema: MemoryDatabaseSchema,
    input: MemoryDatabaseQueryInput,
  ): MemoryDatabaseQueryResult {
    this.#assertSchema(schema, input.schemaKey);
    const registration = this.#spaces.get(input.spaceId)?.get(key(input.namespace));
    if (!registration) throw new Error("SQL 视图 namespace 尚未注册，请重新加载结构");
    if (!registration.ready || registration.schemaKey !== schema.schemaKey)
      throw new Error("SQL 视图结构已失效，请重新加载结构并注册视图");
    return this.#execute(db, schema, registration.columns, input);
  }

  #assertSchema(schema: MemoryDatabaseSchema, expected: string): void {
    if (schema.schemaKey !== expected)
      throw new Error("记忆表结构已变化，请重新加载结构并注册视图");
  }

  #install(db: Database, schema: MemoryDatabaseSchema, registration: Registration): void {
    for (const view of registration.views) {
      if (!/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH)\b/i.test(view.select))
        throw new Error(`SQL 视图必须提供 SELECT 查询：${view.name}`);
      const result = this.#execute(db, schema, registration.columns, { sql: view.select }, true);
      const columns = view.columns ?? result.columns;
      if (
        columns.length !== result.columns.length ||
        new Set(columns.map(key)).size !== columns.length ||
        columns.some((name) => !name || name.includes("\0"))
      )
        throw new Error(`SQL 视图列定义无效：${view.name}`);
      db.exec(
        `CREATE TEMP VIEW ${quote(view.name)} (${columns.map(quote).join(",")}) AS ${view.select}`,
      );
      registration.columns.set(key(view.name), [...columns]);
      // Compile the expanded view too: authorizer checks both source columns and view columns.
      this.#execute(
        db,
        schema,
        registration.columns,
        { sql: `SELECT * FROM ${quote(view.name)}` },
        true,
      );
    }
    registration.ready = true;
  }

  #execute(
    db: Database,
    schema: MemoryDatabaseSchema,
    views: ReadonlyMap<string, readonly string[]>,
    input: Pick<MemoryDatabaseQueryInput, "sql" | "params" | "maxRows" | "budgetMs">,
    prepareOnly = false,
  ): MemoryDatabaseQueryResult {
    const { capi, wasm } = this.#sqlite;
    const started = performance.now();
    const maxRows = input.maxRows ?? 200;
    const budgetMs = input.budgetMs ?? 750;
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000)
      throw new Error("SQL maxRows 必须是 1 到 10000 的整数");
    if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 5000)
      throw new Error("SQL budgetMs 必须在 1 到 5000 之间");
    if (input.sql.includes("\0")) throw new Error("SQL 包含空字符");
    if (new TextEncoder().encode(input.sql).byteLength > 128 * 1024)
      throw new Error("SQL 文本超过 128 KB");
    const deadline = started + budgetMs;
    const allowed = new Map(
      Object.entries(schema.columns).map(([name, columns]) => [
        key(name),
        new Set(columns.map(key)),
      ]),
    );
    for (const [name, columns] of views) allowed.set(name, new Set(columns.map(key)));
    const physicalNames = new Set(
      db
        .selectArrays(
          "SELECT name FROM main.sqlite_schema WHERE type IN ('table','view') UNION ALL SELECT name FROM temp.sqlite_schema WHERE type IN ('table','view')",
        )
        .map((row) => key(String(row[0]))),
    );
    const readActions = new Set<number>([
      capi.SQLITE_SELECT,
      capi.SQLITE_READ,
      capi.SQLITE_FUNCTION,
      capi.SQLITE_RECURSIVE,
    ]);
    const oldLength = capi.sqlite3_limit(db.pointer!, capi.SQLITE_LIMIT_LENGTH, maxResultBytes);
    const oldSqlLength = capi.sqlite3_limit(db.pointer!, capi.SQLITE_LIMIT_SQL_LENGTH, 128 * 1024);
    let source = 0,
      statementPointer = 0,
      tailPointer = 0,
      statement = 0;
    capi.sqlite3_set_authorizer(
      db.pointer!,
      (_arg, action, tableName, columnName, databaseName) => {
        if (!readActions.has(action)) return capi.SQLITE_DENY;
        if (action === capi.SQLITE_FUNCTION) {
          const name = key(String(columnName));
          if (
            (name.startsWith("sqlite_") &&
              !["sqlite_version", "sqlite_source_id"].includes(name)) ||
            name.startsWith("ste_") ||
            ["load_extension", "readfile", "writefile", "fts3_tokenizer"].includes(name)
          )
            return capi.SQLITE_DENY;
        }
        if (action === capi.SQLITE_READ) {
          const name = key(String(tableName));
          if (
            ["json_each", "json_tree"].includes(name) &&
            !physicalNames.has(name) &&
            !views.has(name)
          )
            return capi.SQLITE_OK;
          const columns = allowed.get(name);
          if (
            (databaseName && databaseName !== "main" && databaseName !== "temp") ||
            !columns ||
            (columnName !== "" && !columns.has(key(String(columnName))))
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
    try {
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
        if (code !== capi.SQLITE_OK) {
          if (next) capi.sqlite3_finalize(next);
          if (code === capi.SQLITE_INTERRUPT) throw new Error("SQL 查询超出执行预算");
          db.checkRc(code);
        }
        cursor = wasm.peekPtr(tailPointer);
        if (!next) continue;
        if (statement) {
          capi.sqlite3_finalize(next);
          throw new Error("SQL 只允许一条查询语句");
        }
        statement = next;
      }
      if (!statement || !capi.sqlite3_stmt_readonly(statement))
        throw new Error("SQL 需要一条只读查询语句");
      const columns = Array.from({ length: capi.sqlite3_column_count(statement) }, (_, i) =>
        capi.sqlite3_column_name(statement, i),
      );
      if (!columns.length) throw new Error("SQL 必须返回查询结果");
      const params = input.params ?? {};
      const unused = new Set(Object.keys(params));
      for (const [name, value] of Object.entries(params)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          (value !== null &&
            typeof value !== "string" &&
            !(typeof value === "number" && Number.isFinite(value)))
        )
          throw new Error(`SQL 参数无效：${name}`);
      }
      for (let i = 1; i <= capi.sqlite3_bind_parameter_count(statement); i++) {
        const name = capi.sqlite3_bind_parameter_name(statement, i);
        if (!name || !/^:[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          throw new Error("SQL 只接受 :name 命名参数");
        const param = name.slice(1);
        if (!Object.hasOwn(params, param)) throw new Error(`SQL 缺少绑定参数：${name}`);
        unused.delete(param);
        const value = params[param]!;
        if (typeof value === "string") {
          const bytes = new TextEncoder().encode(value).byteLength;
          if (bytes > maxValueBytes) throw new Error("SQL 单个参数超过 1 MB");
          const text = wasm.allocCString(value, false);
          try {
            db.checkRc(capi.sqlite3_bind_text(statement, i, text, bytes, capi.SQLITE_TRANSIENT));
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
      const rows: MemorySqlScalar[][] = [];
      let truncated = false;
      let bytes = new TextEncoder().encode(JSON.stringify(columns)).byteLength;
      if (bytes > maxResultBytes) throw new Error("SQL 查询结果超过 2 MB");
      if (!prepareOnly) {
        let step: number;
        while ((step = capi.sqlite3_step(statement)) === capi.SQLITE_ROW) {
          if (rows.length === maxRows) {
            truncated = true;
            break;
          }
          const row = columns.map((_, i): MemorySqlScalar => {
            if (capi.sqlite3_column_bytes(statement, i) > maxValueBytes)
              throw new Error("SQL 单值超过 1 MB");
            const value: unknown = capi.sqlite3_column_js(statement, i);
            if (typeof value === "bigint") return value.toString();
            if (value !== null && typeof value !== "string" && typeof value !== "number")
              throw new Error("SQL 只返回字符串、数值和 NULL，请转换 BLOB");
            return value;
          });
          bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
          if (bytes > maxResultBytes) throw new Error("SQL 查询结果超过 2 MB");
          rows.push(row);
        }
        if (!truncated && step !== capi.SQLITE_DONE) {
          if (step === capi.SQLITE_INTERRUPT) throw new Error("SQL 查询超出执行预算");
          db.checkRc(step);
        }
      }
      if (performance.now() >= deadline) throw new Error("SQL 查询超出执行预算");
      return { columns, rows, elapsedMs: performance.now() - started, truncated, maxRows };
    } finally {
      if (statement) capi.sqlite3_finalize(statement);
      if (source) wasm.dealloc(source);
      if (statementPointer) wasm.dealloc(statementPointer);
      if (tailPointer) wasm.dealloc(tailPointer);
      capi.sqlite3_set_authorizer(db.pointer!, () => capi.SQLITE_OK, 0);
      capi.sqlite3_progress_handler(db.pointer!, 0, 0, 0);
      capi.sqlite3_limit(db.pointer!, capi.SQLITE_LIMIT_LENGTH, oldLength);
      capi.sqlite3_limit(db.pointer!, capi.SQLITE_LIMIT_SQL_LENGTH, oldSqlLength);
    }
  }
}
