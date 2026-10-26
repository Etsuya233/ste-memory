import { useState } from "react";
import type { MemoryMacro } from "../../features/macros/macro-expression.ts";
import { macroFromEditorDraft } from "./expression-macro-editor-model.ts";
import { Button, FormField, Input, Select, Switch, Textarea } from "../kit/controls.tsx";
import { Disclosure } from "../shell/disclosure.tsx";
import type { MacroExecutionResult as MacroExecutionView } from "../../features/macros/memory-macro-service.ts";

export interface MacroSchemaHelp {
  readonly key: string;
  readonly name: string;
  readonly fields: readonly { readonly key: string; readonly name: string }[];
  readonly groups: readonly { readonly key: string; readonly name: string }[];
}
export function newExpressionMacro(table: string): MemoryMacro {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: false,
    expression: { language: "query", query: { table, limit: 10 } },
    output: { format: "text", maxChars: null },
  };
}
export function ExpressionMacroEditor(props: {
  readonly initial: MemoryMacro;
  readonly names: readonly string[];
  readonly tables: readonly MacroSchemaHelp[];
  readonly scope: "chat" | "global" | "preset";
  readonly onSave: (macro: MemoryMacro) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly onTest?: (macro: MemoryMacro, lastUserMessage: string) => Promise<MacroExecutionView>;
  readonly recent?: MacroExecutionView;
}) {
  const [name, setName] = useState(props.initial.name);
  const [enabled, setEnabled] = useState(props.initial.enabled);
  const [language, setLanguage] = useState(props.initial.expression.language);
  const [query, setQuery] = useState(
    JSON.stringify(
      props.initial.expression.language === "query"
        ? props.initial.expression.query
        : { table: props.tables[0]?.key ?? "", limit: 10 },
      null,
      2,
    ),
  );
  const [convertedLegacy, setConvertedLegacy] = useState(false);
  const legacyExpression =
    props.initial.expression.language === "sql" &&
    (props.initial.expression.sources?.length ?? 0) > 0
      ? props.initial.expression
      : null;
  const lockedLegacy = legacyExpression !== null && !convertedLegacy;
  const [sql, setSql] = useState(
    props.initial.expression.language === "sql" ? props.initial.expression.sql : "",
  );
  const [format, setFormat] = useState(props.initial.output.format);
  const [maxChars, setMaxChars] = useState(props.initial.output.maxChars?.toString() ?? "");
  const [error, setError] = useState("");
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<MacroExecutionView>();
  const [busy, setBusy] = useState(false);
  function readDraft(): MemoryMacro {
    return macroFromEditorDraft(
      props.initial,
      { name, enabled, language, query, sql, convertedLegacy, format, maxChars },
      props.names,
    );
  }

  async function save() {
    setBusy(true);
    try {
      await props.onSave(readDraft());
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    try {
      const macro = readDraft();
      setTestResult(await props.onTest!(macro, testInput));
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stm-settings-fields" data-expression-macro-editor>
      <FormField label="宏名">
        {(field) => (
          <Input {...field} value={name} onChange={(event) => setName(event.target.value)} />
        )}
      </FormField>
      <div className="stm-setting-row">
        <span>启用</span>
        <Switch
          label="启用宏"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </div>
      <p className="stm-setting-hint">
        停用仍占据同名位置。对话宏优先于全局宏与内置宏，删除后才会使用较低作用域定义。对话宏随记忆空间保存，共享空间的对话共用定义。
      </p>
      {
        <p role="note">
          表达式含语义查询时，启用后实际生成可能请求 embedding；成功缓存可复用查询向量。
          {props.scope === "global"
            ? "此全局宏适用于所有活动对话。"
            : "即使提示词未引用该宏也会执行。"}
        </p>
      }
      <FormField label="表达式语言">
        {(field) => (
          <Select
            {...field}
            value={language}
            disabled={lockedLegacy}
            onChange={(event) => {
              const language = event.target.value as "query" | "sql";
              setLanguage(language);
              setFormat(language === "sql" ? "markdown" : "text");
            }}
          >
            <option value="query">Query JSON</option>
            <option value="sql">SQL</option>
          </Select>
        )}
      </FormField>
      {legacyExpression && (
        <section data-legacy-sql-expression>
          <p role="note">
            此宏使用旧版命名评分源，表达式保留原值。可以改名、启停及调整输出；转换后请手工将 SQL
            改为内联 semantic_scores 调用。保存校验失败会保留旧定义。
          </p>
          <FormField label="原 sources JSON（只读）">
            {(field) => (
              <Textarea
                {...field}
                rows={8}
                readOnly
                value={JSON.stringify(legacyExpression.sources, null, 2)}
              />
            )}
          </FormField>
          <FormField label="原 SQL（只读）">
            {(field) => <Textarea {...field} rows={8} readOnly value={legacyExpression.sql} />}
          </FormField>
          {lockedLegacy ? (
            <Button
              disabled={busy}
              onClick={() => {
                setConvertedLegacy(true);
                setLanguage("sql");
                setSql(legacyExpression.sql);
                setError("");
              }}
            >
              转为内联 SQL 草稿
            </Button>
          ) : (
            <>
              <p>当前是转换草稿；sources 将在保存时移除，原 SQL 尚未自动改写。</p>
              <Button
                disabled={busy}
                onClick={() => {
                  setConvertedLegacy(false);
                  setLanguage("sql");
                  setSql(legacyExpression.sql);
                  setError("");
                }}
              >
                还原旧表达式
              </Button>
            </>
          )}
        </section>
      )}
      {!lockedLegacy &&
        (language === "query" ? (
          <FormField label="Query JSON">
            {(field) => (
              <Textarea
                {...field}
                rows={16}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
          </FormField>
        ) : (
          <>
            <FormField label="SQL 正文">
              {(field) => (
                <Textarea
                  {...field}
                  rows={12}
                  value={sql}
                  onChange={(event) => setSql(event.target.value)}
                />
              )}
            </FormField>
          </>
        ))}
      {language === "sql" && (
        <Disclosure title="内联语义查询与缓存" icon="fa-code">
          <p>
            <span className="stm-mono">semantic_scores(table_key, groups_json, query_text)</span>{" "}
            返回 record_id、score、group_key。三个参数均必填，groups_json 是向量组 Key 的 JSON
            数组。SQL 决定筛选、排序和最终条数。
          </p>
          <pre>{`SELECT e."summary", s.score, s.group_key
FROM "chronicle" AS e
JOIN semantic_scores(
  'chronicle', '["event_memory"]', :last_user_message
) AS s ON s.record_id = e."$record_id"
WHERE s.score >= 0.3
ORDER BY s.score DESC
LIMIT 10;`}</pre>
          <p className="stm-setting-hint">
            示例需按实际表、字段与向量组 Key
            修改。同批相同连接与文本共享查询请求；成功查询向量可在当前插件实例中复用，最多缓存 5
            分钟。每次执行仍按当前快照重新评分和查询，SQL
            结果与宏文本不会跨批缓存。保存仅校验，不请求 embedding。
          </p>
        </Disclosure>
      )}
      <Disclosure title="表、字段与向量组 Key" icon="fa-table">
        <p className="stm-setting-hint">
          Query 通过 table、conditions、fields、orderBy、limit 决定结果。semantic 声明 groups 与
          query；$similarity 可用于字段、条件和排序。Query 输入可用{" "}
          {JSON.stringify({ context: "last_user_message" })} 或{" "}
          {JSON.stringify({ text: "固定查询" })}。
        </p>
        {props.tables.map((table) => (
          <div key={table.key}>
            <strong>
              {table.name} · {table.key}
            </strong>
            <p>字段：{table.fields.map((field) => `${field.name} (${field.key})`).join("、")}</p>
            <p>向量组：{table.groups.map((group) => `${group.name} (${group.key})`).join("、")}</p>
          </div>
        ))}
        <p>
          SQL 可用绑定参数 :last_user_message 读取本次消息；缺少消息时为 NULL。业务表以表 Key
          引用，记录身份列为
          "$record_id"。表达式中的记录身份和字面值会原样保存，跨空间复制后可能无法命中。
        </p>
      </Disclosure>
      <FormField label="输出格式">
        {(field) => (
          <Select
            {...field}
            value={format}
            onChange={(event) => setFormat(event.target.value as MemoryMacro["output"]["format"])}
          >
            <option value="text">文本</option>
            <option value="markdown">Markdown</option>
            <option value="json">JSON</option>
          </Select>
        )}
      </FormField>
      <FormField label="字符预算" hint="留空继承全局上限，按完整行装入；JSON 保持完整。">
        {(field) => (
          <Input
            {...field}
            type="number"
            min={0}
            step={1}
            value={maxChars}
            onChange={(event) => setMaxChars(event.target.value)}
          />
        )}
      </FormField>
      {error && <p role="alert">{error}</p>}
      <div className="stm-setting-actions">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          保存宏
        </Button>
        <Button disabled={busy} onClick={props.onCancel}>
          取消
        </Button>
      </div>
      {props.scope !== "preset" && (
        <>
          <MacroExecutionResult title="最近真实执行" result={props.recent} />
          {props.onTest && (
            <Disclosure title="显式测试" icon="fa-flask">
              <FormField label="last_user_message 测试文本">
                {(field) => (
                  <Textarea
                    {...field}
                    rows={3}
                    value={testInput}
                    onChange={(event) => setTestInput(event.target.value)}
                  />
                )}
              </FormField>
              <p>测试使用当前草稿，可能请求 embedding；测试结果独立保留，最近真实执行保持原值。</p>
              <Button disabled={busy} onClick={() => void test()}>
                执行测试
              </Button>
              <MacroExecutionResult title="显式测试结果" result={testResult} />
            </Disclosure>
          )}
        </>
      )}
    </div>
  );
}
export function MacroExecutionResult(props: {
  readonly title: string;
  readonly result?: MacroExecutionView;
}) {
  const labels = {
    "not-run": "未执行",
    disabled: "停用",
    running: "执行中",
    success: "成功",
    empty: "正常零行",
    error: "错误",
    cancelled: "已取消",
    stale: "已过期",
  };
  return (
    <Disclosure title={props.title} icon="fa-chart-simple">
      <p role="status">{props.result ? labels[props.result.status] : "未执行"}</p>
      {props.result && (
        <>
          {props.result.error && <p role="alert">{props.result.error}</p>}
          <p>
            {props.result.scope === "chat"
              ? "对话宏"
              : props.result.scope === "global"
                ? "全局宏"
                : "内置宏"}{" "}
            · {props.result.startedAt}
          </p>
          <p>
            {props.result.elapsedMs.toFixed(1)} ms · 查询 {props.result.resultRows} 行 · 输出{" "}
            {props.result.outputRows} 行 · {props.result.truncated ? "已省略" : "完整输出"}
          </p>
          <pre>{props.result.text}</pre>
          <p className="stm-setting-hint">查询、索引覆盖与缓存诊断</p>
          <pre>{JSON.stringify(props.result.diagnostics, null, 2)}</pre>
        </>
      )}
      <p className="stm-setting-hint">打开结果只读取最近快照，不会执行查询。</p>
    </Disclosure>
  );
}
