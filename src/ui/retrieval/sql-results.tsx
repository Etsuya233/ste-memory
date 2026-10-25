import { Button } from "../kit/controls.tsx";
import { useEffect, useId, useRef, useState } from "react";
import type {
  SqlExecutionResult,
  SqlResultSet,
  SqlValue,
} from "../../features/sql-console/sql-console.ts";
import { Tabs } from "../kit/tabs.tsx";

export interface SqlRunResult {
  readonly sql: string;
  readonly execution: SqlExecutionResult;
  readonly version: number;
  readonly at: string;
}

function cellText(value: SqlValue): string {
  if (value === null) return "NULL";
  if (value instanceof Uint8Array)
    return `X'${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}'`;
  if (value === "") return '""';
  return String(value);
}

function cellClass(value: SqlValue): string {
  if (value === null) return "stm-sql-cell--null";
  if (value instanceof Uint8Array) return "stm-sql-cell--blob";
  if (typeof value === "number" || typeof value === "bigint") return "stm-sql-cell--number";
  return "";
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (typeof value === "bigint") return value.toString();
  return value;
}

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** 执行结果卡片：统计、多个结果集、可滚动表格与 JSON 复制。 */
export function SqlResults(props: { readonly result: SqlRunResult; readonly dataVersion: number }) {
  const [active, setActive] = useState(0);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const tabsId = useId();
  const sets = props.result.execution.results;
  const totalRows = sets.reduce((count, set) => count + set.rows.length, 0);
  const stale = props.result.version !== props.dataVersion;
  const activeIndex = Math.min(active, Math.max(0, sets.length - 1));
  const current = sets[activeIndex];
  const copied = copyStatus === "已复制";

  useEffect(() => {
    setActive(0);
  }, [props.result]);
  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  function reportCopy(status: string): void {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    setCopyStatus(status);
    copyTimer.current = window.setTimeout(() => setCopyStatus(null), 2400);
  }
  function copyResults(): void {
    let text: string;
    try {
      text = JSON.stringify(sets, jsonReplacer, 2);
    } catch (failure) {
      reportCopy(failureText(failure));
      return;
    }
    if (!navigator.clipboard) {
      reportCopy("当前环境不支持剪贴板。");
      return;
    }
    try {
      void navigator.clipboard.writeText(text).then(
        () => reportCopy("已复制"),
        (failure: unknown) => reportCopy(failureText(failure)),
      );
    } catch (failure) {
      reportCopy(failureText(failure));
    }
  }

  return (
    <section className="stm-sql-results" data-sql-results aria-label="执行结果">
      <div className="stm-sql-card-head">
        <div className="stm-sql-card-title">
          <span className="stm-sql-card-icon">
            <i className="fa-solid fa-table-list" aria-hidden="true" />
          </span>
          <div>
            <h4>执行结果</h4>
            <p className="stm-sql-card-meta">执行于 {props.result.at}</p>
          </div>
        </div>
        <Button
          className="stm-sql-copy-button"
          type="button"
          data-action="sql-copy-json"
          onClick={copyResults}
        >
          <i className={`fa-solid ${copied ? "fa-check" : "fa-copy"}`} aria-hidden="true" />
          {copied ? "已复制" : "复制 JSON"}
        </Button>
      </div>
      <div className="stm-sql-results-body">
        <div className="stm-sql-result-stats" aria-live="polite">
          <span className="stm-sql-stat stm-sql-stat--rows">
            <i className="fa-solid fa-table-list" aria-hidden="true" />
            {totalRows} 行
          </span>
          <span className="stm-sql-stat">
            <i className="fa-solid fa-pen" aria-hidden="true" />
            {props.result.execution.changes} 行变更
          </span>
          <span className="stm-sql-stat">
            <i className="fa-solid fa-stopwatch" aria-hidden="true" />
            {Math.round(props.result.execution.elapsedMs)} ms
          </span>
        </div>
        {copyStatus !== null && !copied && (
          <p className="stm-sql-inline-error" role="alert">
            {copyStatus}
          </p>
        )}
        {props.result.execution.transactionOpen && (
          <div className="stm-sql-banner stm-sql-banner--warning" role="status">
            <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" />
            <span>事务尚未提交，可继续执行 COMMIT 或 ROLLBACK。</span>
          </div>
        )}
        {stale && (
          <div className="stm-sql-banner stm-sql-banner--info" role="status">
            <i className="fa-solid fa-circle-info" aria-hidden="true" />
            <span>数据已变化，请重新执行。</span>
          </div>
        )}
        {sets.length > 1 && (
          <Tabs
            label="结果集"
            value={String(activeIndex)}
            onChange={(value) => setActive(Number(value))}
            className="stm-sql-result-tabs"
            options={sets.map((set, index) => ({
              value: String(index),
              label: (
                <span className="stm-sql-result-tab-label">
                  结果 {index + 1}
                  <small>{set.rows.length} 行</small>
                </span>
              ),
              panelId: `${tabsId}-${index}`,
            }))}
          />
        )}
        {sets.length > 1 ? (
          sets.map((set, index) => (
            <div
              key={index}
              id={`${tabsId}-${index}`}
              role="tabpanel"
              aria-label={`结果 ${index + 1}`}
              hidden={index !== activeIndex}
              className="stm-sql-result-panel"
            >
              <ResultTable set={set} />
            </div>
          ))
        ) : current !== undefined ? (
          <ResultTable set={current} />
        ) : (
          <div className="stm-sql-empty-state">
            <i className="fa-solid fa-circle-check" aria-hidden="true" />
            <div>
              <strong>执行完成</strong>
              <p>执行完成，无结果集。</p>
            </div>
          </div>
        )}
        <details className="stm-sql-executed">
          <summary>
            <i className="fa-solid fa-code" aria-hidden="true" />
            <span>本次执行 SQL</span>
            <i className="fa-solid fa-chevron-right stm-sql-executed-chevron" aria-hidden="true" />
          </summary>
          <pre>{props.result.sql}</pre>
        </details>
      </div>
    </section>
  );
}

function ResultTable(props: { readonly set: SqlResultSet }) {
  return (
    <div className="stm-sql-table-scroll">
      <table>
        <thead>
          <tr>
            {props.set.columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.set.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, position) => (
                <td key={position} className={cellClass(value)}>
                  <pre>{cellText(value)}</pre>
                </td>
              ))}
            </tr>
          ))}
          {props.set.rows.length === 0 && (
            <tr>
              <td className="stm-sql-empty-cell" colSpan={Math.max(props.set.columns.length, 1)}>
                <span>
                  <i className="fa-solid fa-inbox" aria-hidden="true" />
                  没有结果行。
                </span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
