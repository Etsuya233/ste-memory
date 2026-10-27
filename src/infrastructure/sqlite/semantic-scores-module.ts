import { parseSemanticOptions } from "../../features/semantic-query/semantic-options.ts";
import { semanticSourceKey } from "../../features/semantic-query/semantic-scores.ts";
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { effectiveVectorIndexGroups } from "../../features/memory/index.ts";
import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type {
  PreparedSemanticSqlSource,
  SemanticScoreRow,
  SemanticSqlSourceRequest,
} from "../../features/semantic-query/semantic-sql-port.ts";

interface NativeStruct {
  readonly pointer: number;
  dispose(): void;
}
interface NativeIndex extends NativeStruct {
  $nConstraint: number;
  $estimatedRows: bigint;
  $estimatedCost: number;
  nthConstraint(index: number): NativeStruct & { $iColumn: number; $op: number; $usable: number };
  nthConstraintUsage(index: number): NativeStruct & { $argvIndex: number; $omit: number };
}
interface NativeModule extends NativeStruct {
  setupModule(options: {
    catchExceptions: boolean;
    methods: Record<string, (...args: number[]) => number>;
  }): NativeModule;
}
interface NativeVtab {
  xVtab: { create(out: number): NativeStruct; dispose(pointer: number): void };
  xCursor: { create(out: number): NativeStruct; dispose(pointer: number): void };
  xIndexInfo(pointer: number): NativeIndex;
  xRowid(out: number, value: bigint): void;
}
interface ScoreCursor {
  readonly request: SemanticSqlSourceRequest;
  readonly rows: readonly SemanticScoreRow[];
  index: number;
}

/** SQLite's bundled runtime has these vtab APIs; its declarations omit setupModule and $ members. */
export class SemanticScoresModule {
  private readonly module: NativeModule;
  private readonly cursors = new Map<number, ScoreCursor>();
  private readonly tables: MemorySpaceBackup["tables"];
  private readonly fields: MemorySpaceBackup["fields"];
  private sources = new Map<string, readonly SemanticScoreRow[]>();
  private deadline = Infinity;
  pending: SemanticSqlSourceRequest | undefined;
  error: Error | undefined;
  planned = false;

  constructor(
    sqlite: Sqlite3Static,
    db: Database,
    snapshot: MemorySpaceBackup,
    initializeSchema = true,
  ) {
    const { capi, wasm } = sqlite;
    const native = sqlite.vtab as unknown as NativeVtab;
    const Module = capi.sqlite3_module as unknown as { new (): NativeModule };
    const textPointer = wasm.xWrap("sqlite3_value_text", "*", ["*"]) as (pointer: number) => number;
    const decoder = new TextDecoder();
    const estimatedRows = BigInt(snapshot.records.length);
    this.tables = structuredClone(snapshot.tables);
    this.fields = structuredClone(snapshot.fields);
    this.module = new Module().setupModule({
      catchExceptions: true,
      methods: {
        xConnect: (pointer, _aux, _argc, _argv, out) => {
          const code = capi.sqlite3_declare_vtab(
            pointer,
            "CREATE TABLE x(record_id TEXT,score REAL,group_key TEXT,rerank_score REAL,rerank_rank INTEGER,rank INTEGER,table_arg TEXT HIDDEN,groups_arg TEXT HIDDEN,query_arg TEXT HIDDEN,options_arg TEXT HIDDEN)",
          );
          if (code === capi.SQLITE_OK) native.xVtab.create(out);
          return code;
        },
        xDisconnect: (pointer) => {
          native.xVtab.dispose(pointer);
          return capi.SQLITE_OK;
        },
        xOpen: (_table, out) => {
          native.xCursor.create(out);
          return capi.SQLITE_OK;
        },
        xClose: (pointer) => {
          this.cursors.delete(pointer);
          native.xCursor.dispose(pointer);
          return capi.SQLITE_OK;
        },
        xBestIndex: (_table, pointer) => {
          this.planned = true;
          const index = native.xIndexInfo(pointer);
          const selected = new Set<number>();
          let hasOptionsArgument = false;
          try {
            for (let i = 0; i < index.$nConstraint; i++) {
              const constraint = index.nthConstraint(i);
              try {
                if (constraint.$iColumn === 9 && constraint.$op === capi.SQLITE_INDEX_CONSTRAINT_EQ)
                  hasOptionsArgument = true;
                if (
                  constraint.$usable &&
                  constraint.$op === capi.SQLITE_INDEX_CONSTRAINT_EQ &&
                  constraint.$iColumn >= 6 &&
                  constraint.$iColumn <= 9 &&
                  !selected.has(constraint.$iColumn)
                ) {
                  const usage = index.nthConstraintUsage(i);
                  usage.$argvIndex = constraint.$iColumn - 5;
                  usage.$omit = 1;
                  usage.dispose();
                  selected.add(constraint.$iColumn);
                }
              } finally {
                constraint.dispose();
              }
            }
            if (![6, 7, 8].every((column) => selected.has(column))) return capi.SQLITE_CONSTRAINT;
            if (hasOptionsArgument && !selected.has(9)) return capi.SQLITE_CONSTRAINT;
            index.$estimatedRows = estimatedRows;
            index.$estimatedCost = 10000;
            // LIMIT/OFFSET and ORDER BY remain entirely SQLite's responsibility.
            return capi.SQLITE_OK;
          } finally {
            index.dispose();
          }
        },
        xFilter: (pointer, _idx, _text, argc, argv) => {
          try {
            this.checkDeadline();
            if (argc !== 3 && argc !== 4)
              throw new Error("semantic_scores 需要三个或四个 TEXT 参数");
            const values = Array.from({ length: argc }, (_, i) => {
              const value = wasm.peekPtr(argv + i * wasm.sizeofIR("*"));
              if (capi.sqlite3_value_type(value) !== capi.SQLITE_TEXT)
                throw new Error("semantic_scores 参数必须为 TEXT，不能为 NULL 或其他类型");
              const pointer = textPointer(value);
              return decoder.decode(
                wasm.heap8u().subarray(pointer, pointer + capi.sqlite3_value_bytes(value)),
              );
            });
            const [table, groupsJson, query, optionsJson] = values;
            const groups: unknown = JSON.parse(groupsJson!);
            const request = this.request(
              table!,
              groups,
              query!,
              optionsJson === undefined ? undefined : JSON.parse(optionsJson),
            );
            const rows = this.sources.get(this.key(request));
            if (rows === undefined) {
              this.pending = request;
              return capi.SQLITE_ABORT;
            }
            this.cursors.set(pointer, { request, rows, index: 0 });
            return capi.SQLITE_OK;
          } catch (error) {
            this.error = error instanceof Error ? error : new Error(String(error));
            return capi.SQLITE_ERROR;
          }
        },
        xNext: (pointer) => {
          try {
            this.checkDeadline();
            this.cursors.get(pointer)!.index++;
            return capi.SQLITE_OK;
          } catch (error) {
            this.error = error instanceof Error ? error : new Error(String(error));
            return capi.SQLITE_ERROR;
          }
        },
        xEof: (pointer) => {
          const cursor = this.cursors.get(pointer)!;
          return Number(cursor.index >= cursor.rows.length);
        },
        xColumn: (pointer, context, column) => {
          const cursor = this.cursors.get(pointer)!;
          const row = cursor.rows[cursor.index]!;
          const values = [
            row.recordId,
            row.score,
            row.groupKey,
            row.rerankScore ?? null,
            row.rerankRank ?? null,
            row.rank ?? null,
            cursor.request.table,
            JSON.stringify(cursor.request.groups),
            cursor.request.query,
            JSON.stringify(cursor.request.options ?? {}),
          ];
          capi.sqlite3_result_js(context, values[column]);
          return capi.SQLITE_OK;
        },
        xRowid: (pointer, out) => {
          native.xRowid(out, BigInt(this.cursors.get(pointer)!.index + 1));
          return capi.SQLITE_OK;
        },
      },
    });
    db.checkRc(
      capi.sqlite3_create_module_v2(db.pointer!, "semantic_scores", this.module.pointer, 0, () =>
        this.module.dispose(),
      ),
    );
    // Initialize the fixed schema with host rights. This prepares only and never executes xFilter.
    if (initializeSchema)
      db.prepare(
        "SELECT record_id,score,group_key FROM semantic_scores(NULL,NULL,NULL)",
      ).finalize();
  }

  begin(sources: readonly PreparedSemanticSqlSource[], deadline: number): void {
    this.planned = false;
    this.pending = undefined;
    this.error = undefined;
    this.deadline = deadline;
    this.sources = new Map();
    for (const source of sources) {
      this.checkDeadline();
      const request = this.request(source.table, source.groups, source.query, source.options);
      const key = this.key(request);
      if (this.sources.has(key)) throw new Error("重复供给相同的语义评分源");
      this.sources.set(key, source.rows);
    }
  }

  end(): void {
    this.planned = false;
    this.sources.clear();
    this.pending = undefined;
    this.error = undefined;
    this.deadline = Infinity;
  }

  private checkDeadline(): void {
    if (performance.now() >= this.deadline) throw new Error("语义 SQL 超出执行预算");
  }

  private key(request: SemanticSqlSourceRequest): string {
    return semanticSourceKey(request);
  }

  private request(
    tableKey: string,
    groups: unknown,
    query: string,
    rawOptions?: unknown,
  ): SemanticSqlSourceRequest {
    if (!tableKey.trim()) throw new Error("semantic_scores 表 Key 不能为空");
    if (
      !Array.isArray(groups) ||
      !groups.length ||
      groups.some((group) => typeof group !== "string" || !group.trim()) ||
      new Set(groups).size !== groups.length
    )
      throw new Error("semantic_scores groups_json 必须为非空、不重复字符串的 JSON 数组");
    const text = query.trim();
    if (!text || text.length > 4000) throw new Error("semantic_scores 查询文本须为 1–4000 字符");
    const table = this.tables.find((table) => table.key === tableKey && table.enabled);
    if (!table) throw new Error(`语义源的表不存在或已停用：${tableKey}`);
    if (!table.vectorIndex?.enabled) throw new Error(`表未启用向量索引：${tableKey}`);
    const fields = this.fields.filter((field) => field.tableId === table.id);
    const available = effectiveVectorIndexGroups(table.vectorIndex, fields);
    for (const key of groups as string[]) {
      const group = available.find((group) => group.key === key);
      if (
        !group ||
        !group.fieldIds.length ||
        group.fieldIds.some((id) => !fields.some((field) => field.id === id && field.enabled))
      )
        throw new Error(`语义源分组不存在或字段无效：${tableKey}/${key}`);
    }
    const options = parseSemanticOptions(rawOptions);
    return {
      table: tableKey,
      groups: [...groups],
      query: text,
      ...(options === undefined ? {} : { options }),
    };
  }
}
