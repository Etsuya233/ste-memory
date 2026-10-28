import { useEffect, useRef, useState } from "react";
import { Terminal } from "lucide-react";
import type {
  SqlConsole,
  SqlExecutionResult,
  SqlSchemaEntry,
} from "../../../features/sql-console/sql-console.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { Field, FieldLabel } from "../../../ui/primitives/field.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../ui/primitives/accordion.tsx";
import { PageHeader, PageContent, type PageControls } from "../../components/page-layout.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import type { RecordsContext } from "../records-workspace.ts";

export interface SqlServices {
  console: SqlConsole;
  assertContext: (context: RecordsContext) => void;
  onExecuted: (context: RecordsContext) => void | Promise<void>;
}
export function SqlPage(
  props: SqlServices & {
    context: RecordsContext | null;
    controls: PageControls;
    onBack: () => void;
    active: boolean;
  },
) {
  const scope = JSON.stringify([props.context?.chatKey, props.context?.spaceId]);
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="SQL 控制台"
        subtitle={props.context?.title}
        icon={Terminal}
        {...props.controls}
        onBack={props.onBack}
      />
      <PageContent>
        {props.context ? (
          <SqlSession key={scope} {...props} context={props.context} />
        ) : (
          <PageEmpty title="请先打开对话" />
        )}
      </PageContent>
    </div>
  );
}
function SqlSession(props: SqlServices & { context: RecordsContext; active: boolean }) {
  const [sql, setSql] = useState("");
  const [schema, setSchema] = useState<readonly SqlSchemaEntry[]>([]);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [result, setResult] = useState<SqlExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const executing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!props.active) controller.current?.abort();
  }, [props.active]);
  useEffect(() => {
    let cancelled = false;
    void props.console.schema(props.context.spaceId).then(
      (entries) => {
        if (!cancelled) {
          setSchema(entries);
          setSchemaError(null);
        }
      },
      (cause) => {
        if (!cancelled) setSchemaError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.console, props.context.spaceId, revision]);
  async function execute() {
    if (executing.current || !sql.trim()) return;
    executing.current = true;
    setRunning(true);
    setError(null);
    setNotice(null);
    setResult(null);
    const abort = new AbortController();
    controller.current = abort;
    try {
      props.assertContext(props.context);
      const output = await props.console.execute(props.context.spaceId, sql, abort.signal);
      if (mounted.current) setResult(output);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      controller.current = null;
      executing.current = false;
      if (mounted.current) {
        setRunning(false);
        setRevision((value) => value + 1);
        try {
          await props.onExecuted(props.context);
        } catch (cause) {
          setNotice(`界面刷新失败：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
  }
  return (
    <div className="ste:flex ste:min-w-0 ste:flex-col ste:gap-5">
      <StatusNotice>
        修改仅作用于本次加载，不自动保存为记忆快照。执行 SQL 前请确认当前对话与语句内容。
      </StatusNotice>
      <form
        className="ste:flex ste:flex-col ste:gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void execute();
        }}
      >
        <Field>
          <FieldLabel htmlFor="ste-sql-input">SQL 语句</FieldLabel>
          <Textarea
            id="ste-sql-input"
            rows={9}
            spellCheck={false}
            className="ste:font-mono"
            value={sql}
            disabled={running}
            onChange={(event) => setSql(event.target.value)}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === "Enter" &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.stopPropagation();
                void execute();
              }
            }}
            onKeyUp={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter")
                event.stopPropagation();
            }}
          />
        </Field>
        <div className="ste:flex ste:gap-2">
          <Button type="submit" disabled={running || !sql.trim()}>
            {running ? "正在执行…" : "执行 SQL"}
          </Button>
          {running ? (
            <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>
              取消执行
            </Button>
          ) : null}
        </div>
      </form>
      {error ? <PageError title="执行失败" error={error} /> : null}
      {notice ? <StatusNotice variant="destructive">{notice}</StatusNotice> : null}
      {result ? (
        <section className="ste:flex ste:min-w-0 ste:flex-col ste:gap-3" aria-label="SQL 结果">
          <p className="ste:text-sm">
            影响 {result.changes} 行 · {result.elapsedMs.toFixed(0)} ms
            {result.transactionOpen ? " · 事务尚未提交，请执行 COMMIT 或 ROLLBACK" : ""}
          </p>
          {result.results.map((set, index) => (
            <div
              key={index}
              className="ste:max-w-full ste:overflow-x-auto ste:rounded-xl ste:border"
            >
              <table className="ste:w-full ste:text-sm">
                <thead>
                  <tr>
                    {set.columns.map((column, i) => (
                      <th key={i} className="ste:border-b ste:bg-muted ste:p-2 ste:text-left">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {set.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((value, j) => (
                        <td
                          key={j}
                          className="ste:max-w-80 ste:border-b ste:p-2 ste:align-top ste:break-words ste:whitespace-pre-wrap"
                        >
                          {value === null
                            ? "NULL"
                            : value instanceof Uint8Array
                              ? `BLOB (${value.byteLength} 字节)`
                              : String(value)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!set.rows.length ? (
                <p className="ste:p-3 ste:text-sm ste:text-muted-foreground">无结果行</p>
              ) : null}
            </div>
          ))}
          {result.semantic ? (
            <Accordion>
              <AccordionItem>
                <AccordionTrigger>语义查询诊断</AccordionTrigger>
                <AccordionContent>
                  <pre className="ste:overflow-auto ste:text-xs">
                    {JSON.stringify(result.semantic, null, 2)}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          ) : null}
        </section>
      ) : null}
      {schemaError ? (
        <PageError
          title="表结构加载失败"
          error={schemaError}
          onRetry={() => setRevision((value) => value + 1)}
        />
      ) : null}
      <Accordion>
        <AccordionItem>
          <AccordionTrigger>可查询表结构（{schema.length}）</AccordionTrigger>
          <AccordionContent>
            <div className="ste:flex ste:flex-col ste:gap-4">
              {schema.map((entry) => (
                <div key={entry.name} className="ste:flex ste:flex-col ste:gap-2">
                  <p className="ste:font-mono ste:text-sm ste:break-all">{entry.name}</p>
                  <p className="ste:text-xs ste:text-muted-foreground ste:break-all">
                    {entry.columns.map((column) => `${column.name} (${column.type})`).join(" · ")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={running}
                    onClick={() =>
                      setSql(`SELECT * FROM "${entry.name.replaceAll('"', '""')}" LIMIT 20;`)
                    }
                  >
                    查看示例
                  </Button>
                  {entry.vectorGroups?.map((group) => (
                    <p key={group} className="ste:text-xs ste:break-all">
                      向量组：{group}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
