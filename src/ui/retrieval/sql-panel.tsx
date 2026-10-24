import { useEffect, useRef, useState } from "react";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import type {
  SqlConsole,
  SqlExecutionResult,
  SqlSchemaEntry,
  SqlValue,
} from "../../features/sql-console/sql-console.ts";
import { PageChrome } from "../shell/page-layout.tsx";

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

function cellText(value: SqlValue): string {
  if (value === null) return "NULL";
  if (value instanceof Uint8Array)
    return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`;
  if (value === "") return '""';
  return String(value);
}

export function SqlPanel(props: {
  readonly console: SqlConsole;
  readonly spaceId: MemorySpaceId | null;
  readonly active: boolean;
  readonly dataVersion: number;
  readonly onExecuted: () => void;
}) {
  const [sql, setSql] = useState("");
  const [schema, setSchema] = useState<readonly SqlSchemaEntry[]>([]);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    sql: string;
    execution: SqlExecutionResult;
    version: number;
    at: string;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  // Switching chats unmounts the panel; late Worker responses must not change the next chat.
  const mounted = useRef(true);
  const executing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!props.active || !props.spaceId) return;
    let cancelled = false;
    void props.console.schema(props.spaceId).then(
      (entries) => {
        if (!cancelled) {
          setSchema(entries);
          setSchemaError(null);
        }
      },
      (failure: unknown) => {
        if (!cancelled) setSchemaError(String(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.console, props.spaceId, props.active, props.dataVersion, schemaVersion]);

  function insert(text: string): void {
    const input = editor.current!;
    const start = input.selectionStart;
    setSql(sql.slice(0, start) + text + sql.slice(input.selectionEnd));
    input.focus();
    requestAnimationFrame(() => input.setSelectionRange(start + text.length, start + text.length));
  }
  async function execute(): Promise<void> {
    if (!props.spaceId || executing.current) return;
    executing.current = true;
    setRunning(true);
    setError(null);
    setResult(null);
    setCopyStatus(null);
    const submitted = sql;
    try {
      const execution = await props.console.execute(props.spaceId, submitted);
      if (!mounted.current) return;
      setResult({
        sql: submitted,
        execution,
        version: props.dataVersion + 1,
        at: new Date().toLocaleString(),
      });
    } catch (failure) {
      if (mounted.current) setError(String(failure));
    } finally {
      executing.current = false;
      if (mounted.current) {
        setRunning(false);
        setSchemaVersion((version) => version + 1);
        props.onExecuted();
      }
    }
  }
  return (
    <div className="stm-retrieval stm-sql" data-stm-sql>
      {props.active && <PageChrome />}
      {!props.spaceId && <p role="alert">请先绑定有效记忆空间。</p>}
      <p className="stm-setting-hint">
        直接执行当前空间运行库的 SQL。修改仅作用于本次加载，不自动保存为记忆快照。
      </p>
      <details className="stm-sql-schema">
        <summary>表结构 · {schema.length} 个对象</summary>
        <button
          className="stm-button"
          type="button"
          onClick={() => setSchemaVersion((version) => version + 1)}
        >
          刷新结构
        </button>
        {schemaError && <p role="alert">{schemaError}</p>}
        {schema.map((entry) => (
          <details key={entry.name}>
            <summary>
              {entry.name} · {entry.type}
            </summary>
            <div className="stm-action-row">
              <button
                className="stm-button"
                type="button"
                onClick={() => insert(quoteName(entry.name))}
              >
                插入表名
              </button>
              <button
                className="stm-button"
                type="button"
                onClick={() => setSql(`SELECT * FROM ${quoteName(entry.name)};`)}
              >
                示例查询
              </button>
            </div>
            <div className="stm-sql-columns">
              {entry.columns.map((column) => (
                <button
                  className="stm-button"
                  type="button"
                  key={column.name}
                  onClick={() => insert(quoteName(column.name))}
                >
                  {column.name} · {column.type}
                </button>
              ))}
            </div>
            <pre>{entry.sql}</pre>
          </details>
        ))}
      </details>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void execute();
        }}
      >
        <label className="stm-retrieval-query">
          <span>SQL</span>
          <textarea
            ref={editor}
            className="stm-input"
            data-action="sql-input"
            rows={9}
            value={sql}
            spellCheck={false}
            onChange={(event) => setSql(event.target.value)}
            placeholder={'SELECT * FROM "表 Key";'}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void execute();
              } else if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                insert("  ");
              }
            }}
            onKeyUp={(event) => {
              // SillyTavern also binds Ctrl+Enter at document level.
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          />
        </label>
        <div className="stm-action-row">
          <button
            className="stm-button stm-button--primary"
            type="submit"
            data-action="sql-execute"
            disabled={!props.spaceId || running || !sql.trim()}
          >
            {running ? "执行中…" : "执行 SQL"}
          </button>
          <span className="stm-setting-hint">Ctrl / ⌘ + Enter</span>
        </div>
      </form>
      {error && (
        <p role="alert" data-sql-error>
          {error}
        </p>
      )}
      {result && (
        <div data-sql-results>
          <p role="status">
            {result.execution.results.reduce((count, set) => count + set.rows.length, 0)} 行 ·{" "}
            {result.execution.changes} 行变更 · {Math.round(result.execution.elapsedMs)} ms ·{" "}
            {result.at}
          </p>
          {result.execution.transactionOpen && <p>事务尚未提交，可继续执行 COMMIT 或 ROLLBACK。</p>}
          {result.version !== props.dataVersion && <p>数据已变化，请重新执行。</p>}
          <details>
            <summary>本次执行 SQL</summary>
            <pre>{result.sql}</pre>
          </details>
          {result.execution.results.map((set, index) => (
            <div key={index}>
              <h4>
                结果 {index + 1} · {set.rows.length} 行
              </h4>
              <div className="stm-sql-result-scroll">
                <table>
                  <thead>
                    <tr>
                      {set.columns.map((column, position) => (
                        <th key={position}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {set.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((value, position) => (
                          <td key={position}>
                            <pre>{cellText(value)}</pre>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {set.rows.length === 0 && <p>没有结果行。</p>}
            </div>
          ))}
          {result.execution.results.length === 0 && <p>执行完成，无结果集。</p>}
          <button
            className="stm-button"
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(
                  JSON.stringify(
                    result.execution.results,
                    (_key, value: unknown) =>
                      value instanceof Uint8Array
                        ? Array.from(value)
                        : typeof value === "bigint"
                          ? value.toString()
                          : value,
                    2,
                  ),
                )
                .then(
                  () => setCopyStatus("已复制"),
                  (failure: unknown) => setCopyStatus(String(failure)),
                );
            }}
          >
            复制结果 JSON
          </button>
          {copyStatus && <p role="status">{copyStatus}</p>}
        </div>
      )}
    </div>
  );
}
