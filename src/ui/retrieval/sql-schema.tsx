import { useState } from "react";
import type { SqlSchemaEntry } from "../../features/sql-console/sql-console.ts";

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** 运行库对象浏览器：搜索、展开字段、插入表名或生成示例查询。 */
export function SqlSchema(props: {
  readonly entries: readonly SqlSchemaEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onInsert: (text: string) => void;
  readonly onQuery: (sql: string) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const filtered =
    needle === ""
      ? props.entries
      : props.entries.filter(
          (entry) =>
            entry.name.toLocaleLowerCase().includes(needle) ||
            entry.columns.some((column) => column.name.toLocaleLowerCase().includes(needle)),
        );
  const searching = needle !== "";
  return (
    <aside className="stm-sql-schema" aria-label="表结构" aria-busy={props.loading}>
      <div className="stm-sql-card-head">
        <div className="stm-sql-card-title">
          <span className="stm-sql-card-icon">
            <i className="fa-solid fa-database" aria-hidden="true" />
          </span>
          <div>
            <h4>表结构</h4>
            <p className="stm-sql-card-meta">
              {props.loading && props.entries.length === 0
                ? "正在读取…"
                : searching
                  ? `${filtered.length} / ${props.entries.length} 个对象`
                  : `${props.entries.length} 个对象`}
            </p>
          </div>
        </div>
        <button
          className="stm-sql-icon-button"
          type="button"
          aria-label="刷新表结构"
          title="刷新表结构"
          disabled={props.loading}
          onClick={props.onRefresh}
        >
          <i
            className={`fa-solid fa-rotate-right${props.loading ? " fa-spin" : ""}`}
            aria-hidden="true"
          />
        </button>
      </div>
      <div className="stm-sql-schema-body">
        <div className="stm-sql-search">
          <i className="fa-solid fa-magnifying-glass stm-sql-search-icon" aria-hidden="true" />
          <input
            className="stm-sql-search-input"
            type="search"
            aria-label="搜索表或字段"
            placeholder="搜索表或字段…"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query !== "" && (
            <button
              className="stm-sql-search-clear"
              type="button"
              aria-label="清除搜索"
              title="清除搜索"
              onClick={() => setQuery("")}
            >
              <i className="fa-solid fa-xmark" aria-hidden="true" />
            </button>
          )}
        </div>
        {props.error !== null && (
          <p className="stm-sql-inline-error" role="alert">
            {props.error}
          </p>
        )}
        {props.loading && props.entries.length === 0 ? (
          <div className="stm-sql-schema-loading" role="status">
            <i className="fa-solid fa-circle-notch fa-spin" aria-hidden="true" />
            正在读取表结构…
          </div>
        ) : props.error !== null && props.entries.length === 0 ? null : filtered.length === 0 ? (
          <div className="stm-sql-schema-empty">
            <i
              className={`fa-solid ${searching ? "fa-magnifying-glass" : "fa-database"}`}
              aria-hidden="true"
            />
            <p>
              {searching
                ? `没有匹配“${query.trim()}”的对象。`
                : "当前空间没有可浏览的 SQLite 对象。"}
            </p>
          </div>
        ) : (
          <div className="stm-sql-tables">
            {filtered.map((entry, index) => (
              <SchemaTable
                key={`${entry.type}:${entry.name}:${index}`}
                entry={entry}
                searching={searching}
                onInsert={props.onInsert}
                onQuery={props.onQuery}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function SchemaTable(props: {
  readonly entry: SqlSchemaEntry;
  readonly searching: boolean;
  readonly onInsert: (text: string) => void;
  readonly onQuery: (sql: string) => void;
}) {
  const { entry } = props;
  return (
    <details className="stm-sql-table" open={props.searching || undefined}>
      <summary className="stm-sql-table-summary">
        <i className="fa-solid fa-table stm-sql-table-icon" aria-hidden="true" />
        <span className="stm-sql-table-name" title={entry.name}>
          {entry.name}
        </span>
        <span className="stm-sql-type">{entry.type}</span>
        {entry.columns.length > 0 && (
          <span className="stm-sql-table-count">{entry.columns.length} 列</span>
        )}
        <i className="fa-solid fa-chevron-right stm-sql-table-chevron" aria-hidden="true" />
      </summary>
      <div className="stm-sql-table-body">
        <div className="stm-sql-table-actions">
          <button
            className="stm-sql-mini-button"
            type="button"
            title="在光标处插入表名"
            onClick={() => props.onInsert(quoteName(entry.name))}
          >
            <i className="fa-solid fa-quote-left" aria-hidden="true" />
            插入表名
          </button>
          <button
            className="stm-sql-mini-button"
            type="button"
            title="生成示例查询"
            onClick={() => props.onQuery(`SELECT * FROM ${quoteName(entry.name)};`)}
          >
            <i className="fa-solid fa-play" aria-hidden="true" />
            SELECT *
          </button>
        </div>
        {entry.columns.length > 0 && (
          <div className="stm-sql-columns">
            {entry.columns.map((column, index) => (
              <button
                className="stm-sql-column"
                type="button"
                key={`${column.name}:${index}`}
                title={`插入列名 ${column.name}${column.type ? ` · ${column.type}` : ""}`}
                onClick={() => props.onInsert(quoteName(column.name))}
              >
                <span>{column.name}</span>
                <small>{column.type || "—"}</small>
              </button>
            ))}
          </div>
        )}
        {entry.vectorGroups && (
          <div className="stm-sql-table-actions">
            <span>向量组：{entry.vectorGroups.length ? "" : "未启用"}</span>
            {entry.vectorGroups.map((group) => (
              <button
                key={group}
                className="stm-sql-mini-button"
                type="button"
                onClick={() =>
                  props.onQuery(
                    `SELECT t."$display_text", s.score, s.group_key FROM ${quoteName(entry.name)} t JOIN semantic_scores('${entry.name.replaceAll("'", "''")}', json_array('${group.replaceAll("'", "''")}'), '查询文本') s ON s.record_id=t."$record_id" ORDER BY s.score DESC LIMIT 10;`,
                  )
                }
              >
                {group}
              </button>
            ))}
          </div>
        )}
        {entry.sql !== null && (
          <details className="stm-sql-ddl">
            <summary>
              <i className="fa-solid fa-chevron-right stm-sql-ddl-chevron" aria-hidden="true" />
              建表 SQL
            </summary>
            <pre>{entry.sql}</pre>
          </details>
        )}
      </div>
    </details>
  );
}
