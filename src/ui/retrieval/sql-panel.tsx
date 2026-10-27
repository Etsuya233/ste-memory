import { SemanticQueryError } from "../../features/semantic-query/semantic-query-service.ts";
import { Button, Textarea } from "../kit/controls.tsx";
import { useEffect, useRef, useState } from "react";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import type { SqlConsole, SqlSchemaEntry } from "../../features/sql-console/sql-console.ts";
import { PageChrome } from "../shell/page-layout.tsx";
import { SqlResults, type SqlRunResult } from "./sql-results.tsx";
import { SqlSchema } from "./sql-schema.tsx";

const failureText = (failure: unknown): string => {
  if (failure instanceof SemanticQueryError && failure.diagnostics.queryVectors) {
    const stats = failure.diagnostics.queryVectors;
    return `${failure.message}\n查询向量请求 ${stats.requests} 次，批次缓存命中 ${stats.executionHits} 次，短期缓存命中 ${stats.sharedHits} 次，SQL 执行 ${failure.diagnostics.sqlPasses} 轮。`;
  }
  return failure instanceof Error ? failure.message : String(failure);
};

export function SqlPanel(props: {
  readonly console: SqlConsole;
  readonly spaceId: MemorySpaceId | null;
  readonly active: boolean;
  readonly dataVersion: number;
  readonly onExecuted: () => void;
}) {
  const [sql, setSql] = useState("");
  const request = useRef<AbortController | null>(null);
  const [schema, setSchema] = useState<readonly SqlSchemaEntry[]>([]);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SqlRunResult | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  // Switching chats unmounts the panel; late Worker responses must not change the next chat.
  const mounted = useRef(true);
  const executing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!props.active) return;
    if (!props.spaceId) {
      setSchema([]);
      setSchemaError(null);
      setSchemaLoading(false);
      return;
    }
    let cancelled = false;
    setSchemaLoading(true);
    void props.console
      .schema(props.spaceId)
      .then(
        (entries) => {
          if (!cancelled) {
            setSchema(entries);
            setSchemaError(null);
          }
        },
        (failure: unknown) => {
          if (!cancelled) setSchemaError(failureText(failure));
        },
      )
      .finally(() => {
        if (!cancelled) setSchemaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.console, props.spaceId, props.active, props.dataVersion, schemaVersion]);

  const lineCount = sql === "" ? 1 : sql.split("\n").length;

  function syncGutter(): void {
    if (editor.current && gutter.current) gutter.current.scrollTop = editor.current.scrollTop;
  }
  function focusEditor(position: number): void {
    const input = editor.current;
    if (!input) return;
    input.focus();
    requestAnimationFrame(() => {
      input.setSelectionRange(position, position);
      syncGutter();
    });
  }
  function insert(text: string): void {
    const input = editor.current;
    if (!input) return;
    const start = input.selectionStart ?? sql.length;
    const end = input.selectionEnd ?? start;
    setSql(sql.slice(0, start) + text + sql.slice(end));
    focusEditor(start + text.length);
  }
  function applyQuery(text: string): void {
    setSql(text);
    setError(null);
    focusEditor(text.length);
  }
  function clearEditor(): void {
    setSql("");
    setError(null);
    setResult(null);
    focusEditor(0);
  }
  async function execute(): Promise<void> {
    if (!props.spaceId || executing.current || sql.trim() === "") return;
    executing.current = true;
    setRunning(true);
    setError(null);
    setResult(null);
    const submitted = sql;
    const controller = new AbortController();
    request.current = controller;
    try {
      const execution = await props.console.execute(props.spaceId, submitted, controller.signal);
      if (!mounted.current) return;
      setResult({
        sql: submitted,
        execution,
        version: props.dataVersion + 1,
        at: new Date().toLocaleString("zh-CN", { hour12: false }),
      });
    } catch (failure) {
      if (mounted.current) setError(failureText(failure));
    } finally {
      request.current = null;
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
      {!props.spaceId && (
        <div className="stm-sql-notice" role="alert">
          <i className="fa-solid fa-circle-exclamation" aria-hidden="true" />
          <span>请先绑定有效记忆空间。</span>
        </div>
      )}
      <div className="stm-sql-workbench">
        <div className="stm-sql-main">
          <section
            className="stm-sql-card stm-sql-editor"
            aria-label="查询编辑器"
            aria-busy={running}
          >
            <div className="stm-sql-card-head">
              <div className="stm-sql-card-title">
                <span className="stm-sql-card-icon">
                  <i className="fa-solid fa-terminal" aria-hidden="true" />
                </span>
                <div>
                  <h4>查询编辑器</h4>
                  <p className="stm-sql-card-meta">修改仅作用于本次加载，不自动保存为记忆快照。</p>
                </div>
              </div>
            </div>
            <form
              className="stm-sql-editor-form"
              aria-label="SQL 查询"
              onSubmit={(event) => {
                event.preventDefault();
                void execute();
              }}
            >
              <p className="stm-sql-card-meta">
                支持 semantic_scores('表Key', json_array('组Key'),
                '查询文本')。右侧向量组可生成示例。
              </p>
              <div className="stm-sql-editor-body">
                <div className="stm-sql-gutter" ref={gutter} aria-hidden="true">
                  {Array.from({ length: lineCount }, (_, index) => (
                    <span key={index}>{index + 1}</span>
                  ))}
                </div>
                <Textarea
                  ref={editor}
                  className="stm-sql-textarea"
                  data-action="sql-input"
                  aria-label="SQL 输入"
                  rows={9}
                  wrap="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={sql}
                  onChange={(event) => setSql(event.target.value)}
                  onScroll={syncGutter}
                  placeholder={'SELECT * FROM "表 Key" LIMIT 20;'}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      void execute();
                    } else if (
                      event.key === "Tab" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
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
              </div>
              <div className="stm-sql-editor-foot">
                <div className="stm-sql-editor-meta">
                  <span>
                    {lineCount} 行 · {sql.length} 字符
                  </span>
                  <span className="stm-sql-shortcut" title="Ctrl 或 Command + Enter 执行">
                    <kbd>Ctrl</kbd>
                    <span>/</span>
                    <kbd>Cmd</kbd>
                    <span>+</span>
                    <kbd>Enter</kbd>
                  </span>
                </div>
                <div className="stm-sql-editor-actions">
                  {running && (
                    <Button type="button" onClick={() => request.current?.abort()}>
                      取消查询
                    </Button>
                  )}
                  <Button
                    className="stm-sql-ghost-button"
                    type="button"
                    onClick={clearEditor}
                    disabled={running || (sql === "" && result === null && error === null)}
                  >
                    <i className="fa-solid fa-eraser" aria-hidden="true" />
                    清空
                  </Button>
                  <Button
                    variant="primary"
                    className="stm-sql-run-button"
                    type="submit"
                    data-action="sql-execute"
                    disabled={!props.spaceId || running || sql.trim() === ""}
                  >
                    <i
                      className={`fa-solid ${running ? "fa-circle-notch fa-spin" : "fa-play"}`}
                      aria-hidden="true"
                    />
                    {running ? "执行中…" : "执行 SQL"}
                  </Button>
                </div>
              </div>
            </form>
          </section>
          {error !== null && (
            <div className="stm-sql-error" role="alert" data-sql-error>
              <div className="stm-sql-error-title">
                <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" />
                <strong>执行失败</strong>
              </div>
              <pre>{error}</pre>
            </div>
          )}
          {result !== null && <SqlResults result={result} dataVersion={props.dataVersion} />}
        </div>
        <SqlSchema
          entries={schema}
          loading={schemaLoading}
          error={schemaError}
          onRefresh={() => setSchemaVersion((version) => version + 1)}
          onInsert={insert}
          onQuery={applyQuery}
        />
      </div>
    </div>
  );
}
