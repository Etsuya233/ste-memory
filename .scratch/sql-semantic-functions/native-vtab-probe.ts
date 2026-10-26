import assert from "node:assert/strict";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

// Narrow exploratory probe: no production code or embedding provider is involved.
const sqlite: any = await sqlite3InitModule();
const { capi, wasm, vtab } = sqlite;
const db = new sqlite.oo1.DB(":memory:", "c");
const log: any[] = [];
let label = "";
let strict = false;
let requireSource = false;
const sources = new Map<string, any[]>();
const pending = new Set<string>();
const module = new capi.sqlite3_module().setupModule({
  catchExceptions: true,
  methods: {
    xConnect(pDb: number, _aux: number, _argc: number, _argv: number, out: number) {
      log.push({ label, phase: "xConnect" });
      const code = capi.sqlite3_declare_vtab(
        pDb,
        "CREATE TABLE x(record_id TEXT,score REAL,group_key TEXT,table_arg TEXT HIDDEN,group_arg TEXT HIDDEN,query_arg TEXT HIDDEN)",
      );
      if (!code) vtab.xVtab.create(out);
      return code;
    },
    xDisconnect(pVtab: number) {
      vtab.xVtab.dispose(pVtab);
      return 0;
    },
    xOpen(_pVtab: number, out: number) {
      vtab.xCursor.create(out);
      return 0;
    },
    xClose(pCursor: number) {
      vtab.xCursor.dispose(pCursor);
      return 0;
    },
    xBestIndex(_pVtab: number, pInfo: number) {
      const info = vtab.xIndexInfo(pInfo);
      const available = new Set<number>();
      const constraints: any[] = [];
      let literalMask = 0;
      try {
        for (let i = 0; i < info.$nConstraint; i++) {
          const c = info.nthConstraint(i);
          const rhsOut = wasm.allocPtr(1);
          let value;
          let rc;
          try {
            rc = capi.sqlite3_vtab_rhs_value(pInfo, i, rhsOut);
            const ptr = wasm.peekPtr(rhsOut);
            if (rc === capi.SQLITE_OK && ptr) value = capi.sqlite3_value_to_js(ptr);
          } finally {
            wasm.dealloc(rhsOut);
          }
          constraints.push({
            column: c.$iColumn,
            op: c.$op,
            usable: c.$usable,
            rhsCode: rc,
            value,
          });
          if (
            c.$usable &&
            c.$op === capi.SQLITE_INDEX_CONSTRAINT_EQ &&
            c.$iColumn >= 3 &&
            c.$iColumn <= 5
          ) {
            const arg = c.$iColumn - 3;
            const usage = info.nthConstraintUsage(i);
            usage.$argvIndex = arg + 1;
            usage.$omit = 1;
            usage.dispose();
            available.add(arg);
            if (rc === capi.SQLITE_OK) literalMask |= 1 << arg;
          }
          c.dispose();
        }
        log.push({ label, phase: "xBestIndex", constraints });
        if (available.size !== 3) return capi.SQLITE_CONSTRAINT;
        info.$idxNum = literalMask;
        info.$estimatedRows = 2n;
        info.$estimatedCost = 10;
        return 0;
      } finally {
        info.dispose();
      }
    },
    xFilter(pCursor: number, mask: number, _idxStr: number, argc: number, argv: number) {
      const values = capi.sqlite3_values_to_js(argc, argv);
      const flags = Array.from({ length: argc }, (_, i) =>
        capi.sqlite3_value_frombind(wasm.peekPtr(argv + i * wasm.ptr.size)),
      );
      log.push({
        label,
        phase: "xFilter",
        mask,
        values,
        fromBind: flags,
        strict,
      });
      const cursor = vtab.xCursor.get(pCursor);
      if (strict && flags.some((flag: number, i: number) => !(mask & (1 << i)) && !flag)) {
        vtab.xVtab.get(cursor.$pVtab).$zErrMsg = wasm.allocCString(
          "STE_NON_LITERAL_NON_BIND_ARGUMENT",
        );
        return capi.SQLITE_CONSTRAINT;
      }
      const key = JSON.stringify(values);
      if (requireSource && !sources.has(key)) {
        pending.add(key);
        vtab.xVtab.get(cursor.$pVtab).$zErrMsg = wasm.allocCString("STE_SEMANTIC_SOURCE_PENDING");
        return capi.SQLITE_ABORT;
      }
      cursor.probeRows = sources.get(key) ?? [
        ["r1", 0.9, values[1]],
        ["r2", 0.6, values[1]],
      ];
      cursor.probeIndex = 0;
      return 0;
    },
    xNext(pCursor: number) {
      vtab.xCursor.get(pCursor).probeIndex++;
      return 0;
    },
    xEof(pCursor: number) {
      const c = vtab.xCursor.get(pCursor);
      return Number(c.probeIndex >= c.probeRows.length);
    },
    xColumn(pCursor: number, ctx: number, col: number) {
      const c = vtab.xCursor.get(pCursor);
      capi.sqlite3_result_js(ctx, c.probeRows[c.probeIndex][col]);
      return 0;
    },
    xRowid(pCursor: number, out: number) {
      vtab.xRowid(out, BigInt(vtab.xCursor.get(pCursor).probeIndex + 1));
      return 0;
    },
  },
});
db.checkRc(capi.sqlite3_create_module(db.pointer, "semantic_scores", module, 0));
db.exec("CREATE TABLE outer_inputs(q TEXT);INSERT INTO outer_inputs VALUES('first'),('second');");
function run(name: string, sql: string, bind?: Record<string, string>) {
  label = name;
  let stmt: any;
  try {
    stmt = db.prepare(sql);
    if (bind) stmt.bind(bind);
    const rows = [];
    while (stmt.step()) rows.push(stmt.get([]));
    log.push({ label, phase: "result", rows });
  } catch (error: any) {
    log.push({
      label,
      phase: "error",
      code: error.resultCode,
      message: error.message,
    });
  } finally {
    stmt?.finalize();
  }
}
try {
  const classificationCases = [
    { name: "ordinary_select", sql: "SELECT q FROM outer_inputs" },
    {
      name: "direct_function",
      sql: "SELECT * FROM semantic_scores('facts','group','question')",
    },
    {
      name: "count_star",
      sql: "SELECT count(*) FROM semantic_scores('facts','group','question')",
    },
    {
      name: "cte",
      sql: "WITH scores AS(SELECT * FROM semantic_scores('facts','group','question')) SELECT record_id FROM scores",
    },
    {
      name: "subquery",
      sql: "SELECT score FROM(SELECT * FROM semantic_scores('facts','group','question'))",
    },
    {
      name: "where_false",
      sql: "SELECT * FROM semantic_scores('facts','group','question') WHERE 0",
    },
    {
      name: "bound_branch_false",
      sql: "SELECT CASE WHEN :enabled THEN(SELECT count(*) FROM semantic_scores('facts','group','question')) ELSE 0 END",
      bind: { ":enabled": 0 },
    },
    {
      name: "bound_branch_true",
      sql: "SELECT CASE WHEN :enabled THEN(SELECT count(*) FROM semantic_scores('facts','group','question')) ELSE 0 END",
      bind: { ":enabled": 1 },
    },
    {
      name: "unused_cte",
      sql: "WITH unused AS(SELECT * FROM semantic_scores('facts','group','question')) SELECT 1",
    },
    { name: "ordinary_after_connect", sql: "SELECT 1" },
  ];
  for (const entry of classificationCases) {
    label = "classify:" + entry.name;
    const reads: any[] = [];
    const filterCount = log.filter((event) => event.phase === "xFilter").length;
    capi.sqlite3_set_authorizer(
      db.pointer,
      (_arg: number, action: number, table: string, column: string) => {
        if (action === capi.SQLITE_READ) reads.push({ table, column });
        return capi.SQLITE_OK;
      },
      0,
    );
    let stmt: any;
    try {
      stmt = db.prepare(entry.sql);
      if (entry.bind) stmt.bind(entry.bind);
    } finally {
      stmt?.finalize();
      capi.sqlite3_set_authorizer(db.pointer, () => capi.SQLITE_OK, 0);
    }
    const classified = reads.some(
      (read) =>
        read.table.replace(/[A-Z]/g, (letter: string) => letter.toLowerCase()) ===
        "semantic_scores",
    );
    log.push({
      label,
      phase: "classification",
      reads,
      classified,
      stepped: false,
    });
    assert.equal(log.filter((event) => event.phase === "xFilter").length, filterCount);
    assert.equal(
      classified,
      !["ordinary_select", "unused_cte", "ordinary_after_connect"].includes(entry.name),
    );
  }
  assert(
    log
      .find((event) => event.label === "classify:count_star" && event.phase === "classification")
      .reads.some((read: any) => read.table === "semantic_scores" && read.column === ""),
  );
  for (const mode of [false, true]) {
    strict = mode;
    const prefix = mode ? "strict:" : "observe:";
    run(prefix + "literal", "SELECT * FROM semantic_scores('facts','group','question')");
    run(prefix + "named_bind", "SELECT * FROM semantic_scores('facts','group',:q)", {
      ":q": "bound",
    });
    run(
      prefix + "outer_column",
      "SELECT o.q,s.score FROM outer_inputs o CROSS JOIN semantic_scores('facts','group',o.q) s",
    );
    run(
      prefix + "constant_expression",
      "SELECT * FROM semantic_scores('facts','group','ques'||'tion')",
    );
    run(prefix + "positional_bind", "SELECT * FROM semantic_scores('facts','group',?1)", {
      "?1": "positional",
    });
    run(prefix + "cast_bind", "SELECT * FROM semantic_scores('facts','group',CAST(:q AS TEXT))", {
      ":q": "bound",
    });
    run(
      prefix + "bound_cte_column",
      "WITH inputs(q) AS(SELECT :q UNION ALL SELECT :q2) SELECT i.q,s.score FROM inputs i CROSS JOIN semantic_scores('facts','group',i.q) s",
      { ":q": "bound-one", ":q2": "bound-two" },
    );
  }

  strict = true;
  requireSource = true;
  label = "pending:reset";
  const text =
    "SELECT record_id,score FROM semantic_scores('facts','group',:q) ORDER BY score DESC LIMIT 1";
  const stmt = db.prepare(text);
  stmt.bind({ ":q": "missing" });
  try {
    stmt.step();
    throw new Error("expected pending error");
  } catch (error: any) {
    log.push({
      label,
      phase: "first_error",
      code: error.resultCode,
      message: error.message,
      pending: [...pending],
    });
  }
  for (const key of pending)
    sources.set(key, [
      ["prepared-low", 0.1, "group"],
      ["prepared-high", 0.99, "group"],
    ]);
  pending.clear();
  log.push({ label, phase: "reset", code: stmt.resetNoThrow() });
  const rows = [];
  while (stmt.step()) rows.push(stmt.get([]));
  log.push({ label, phase: "rerun", rows });
  stmt.finalize();
  sources.clear();
  label = "pending:partial_rows";
  const partial = db.prepare(
    "SELECT 'prefix' AS record_id,0 AS score UNION ALL SELECT record_id,score FROM semantic_scores('facts','group',:q)",
  );
  partial.bind({ ":q": "partial" });
  const prefixRows = [];
  try {
    while (partial.step()) prefixRows.push(partial.get([]));
  } catch (error: any) {
    log.push({
      label,
      phase: "error_after_rows",
      code: error.resultCode,
      message: error.message,
      prefixRows,
    });
  }
  for (const key of pending) sources.set(key, [["late-row", 0.9, "group"]]);
  pending.clear();
  partial.resetNoThrow();
  const rerunRows = [];
  while (partial.step()) rerunRows.push(partial.get([]));
  log.push({ label, phase: "complete_retry", rows: rerunRows });
  partial.finalize();
  sources.clear();
  run("pending:reprepare_first", text, { ":q": "new-missing" });
  for (const key of pending)
    sources.set(key, [
      ["all-source-first", 0.2, "group"],
      ["all-source-best", 0.95, "group"],
    ]);
  pending.clear();
  run("pending:reprepare_second", text, { ":q": "new-missing" });
  const filters = (name: string) =>
    log.filter((event) => event.label === name && event.phase === "xFilter");
  assert.deepEqual(filters("observe:literal")[0].fromBind, [0, 0, 0]);
  assert.equal(filters("observe:literal")[0].mask, 7);
  for (const name of ["named_bind", "positional_bind", "cast_bind"]) {
    assert.equal(filters("observe:" + name)[0].fromBind[2], 1);
    assert.equal(filters("observe:" + name)[0].mask, 3);
  }
  assert.deepEqual(
    filters("strict:bound_cte_column").map((event) => [event.values[2], event.fromBind[2]]),
    [
      ["bound-one", 1],
      ["bound-two", 1],
    ],
  );
  assert(
    log.some((event) => event.label === "strict:bound_cte_column" && event.phase === "result"),
  );
  for (const name of ["outer_column", "constant_expression"])
    assert(
      log.some(
        (event) =>
          event.label === "strict:" + name &&
          event.phase === "error" &&
          event.code === capi.SQLITE_CONSTRAINT,
      ),
    );
  assert.deepEqual(
    log.find((event) => event.label === "pending:reset" && event.phase === "rerun").rows,
    [["prepared-high", 0.99]],
  );
  assert.deepEqual(
    log.find((event) => event.label === "pending:reprepare_second" && event.phase === "result")
      .rows,
    [["all-source-best", 0.95]],
  );
  assert.deepEqual(
    log.find(
      (event) => event.label === "pending:partial_rows" && event.phase === "error_after_rows",
    ).prefixRows,
    [["prefix", 0]],
  );
  console.log(
    JSON.stringify(
      {
        sqlite: capi.sqlite3_libversion(),
        node: process.version,
        exports: {
          rhs: typeof capi.sqlite3_vtab_rhs_value,
          fromBind: typeof capi.sqlite3_value_frombind,
        },
        log,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  module.dispose();
}
