/**
 * 日志 Tab（ADR 0015）：纯查询页——类型/级别/Key 过滤、「查询」按钮刷新、时间
 * 倒序结果列表、点击单条原样展开文本（`<pre>`，同一时间只展开一条）、清空日志。
 * 任务面板提供「日志」入口跳转（focusRunId 作为 Key 过滤并立即查询一次）。
 *
 * 纯逻辑在 log-panel-model（可测），本组件只做「状态 → DOM」投影与事件接线；
 * 查询侧零业务解析：文本原样展示，不做类型专属摘要、状态解码或结构折叠。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import type { LogEntry, LogRepository } from "../../features/logging/log.ts";
import {
  buildLogListViewModel,
  defaultLogFilters,
  LOG_LEVEL_LABELS,
  LOG_TYPE_OPTIONS,
  logQueryKind,
  type LogPanelFilters,
} from "./log-panel-model.ts";
import { copyText, Placeholder, reportError, reportSuccess } from "../shell/ui-helpers.tsx";
import { LOG_LIMIT } from "../../features/logging/log.ts";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBarAction } from "../shell/panel-bar.tsx";
import { Disclosure } from "../shell/disclosure.tsx";

/** 列表单次拉取上限 = 仓库全局上限：内存过滤（type/level）能命中全部保留条目 */
const LOG_PANEL_FETCH_LIMIT = LOG_LIMIT;

export interface LogTabRuntime {
  readonly logs: Pick<LogRepository, "byKey" | "recent" | "clearAll">;
}

const LEVEL_OPTIONS = ["info", "warn", "error"] as const;

export function LogTab(props: {
  readonly runtime: LogTabRuntime;
  readonly settings: PluginSettings;
  /** 任务面板跳转定位：作为 Key 过滤应用并立即查询一次后消费 */
  readonly focusRunId: string | null;
  readonly onFocusConsumed: () => void;
}) {
  const [filters, setFilters] = useState<LogPanelFilters>(() => defaultLogFilters());
  const [entries, setEntries] = useState<readonly LogEntry[] | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [queryToken, setQueryToken] = useState(0);
  const [querying, setQuerying] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const detailId = useId();
  // 查询只在进入页面/点「查询」/任务跳转时执行；用 ref 读取最新过滤状态，
  // 使 refresh 的标识稳定（过滤输入本身不触发重新查询）。
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const refresh = useCallback(async () => {
    const current = filtersRef.current;
    const sequence = ++requestSequence.current;
    setQuerying(true);
    setFailure(null);
    try {
      const base =
        logQueryKind(current) === "key"
          ? await props.runtime.logs.byKey(current.key.trim(), LOG_PANEL_FETCH_LIMIT)
          : await props.runtime.logs.recent(LOG_PANEL_FETCH_LIMIT);
      if (sequence === requestSequence.current) setEntries(base);
    } catch (error) {
      if (sequence === requestSequence.current) {
        setFailure(error instanceof Error ? error.message : String(error));
        reportError(error);
      }
    } finally {
      if (sequence === requestSequence.current) setQuerying(false);
    }
  }, [props.runtime]);

  // 进入页面自动执行一次；「查询」按钮/任务跳转经 queryToken 显式刷新
  useEffect(() => {
    void refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [refresh, queryToken]);

  // 任务面板跳转：应用 Key 过滤并立即查询一次后消费焦点
  useEffect(() => {
    if (props.focusRunId === null) return;
    setFilters((current) => ({ ...current, key: props.focusRunId! }));
    setQueryToken((token) => token + 1);
    props.onFocusConsumed();
  }, [props.focusRunId]);

  /** 手动清空全部日志（独立库审计数据——用户主动入口） */
  async function clearLogs(): Promise<void> {
    if (!window.confirm("清空全部日志？删除后不可恢复，当前筛选范围之外的日志也会清空。")) return;
    setClearing(true);
    setFailure(null);
    try {
      await props.runtime.logs.clearAll();
      reportSuccess("已清空日志");
      setExpandedId(null);
      setQueryToken((token) => token + 1);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      reportError(error);
    } finally {
      setClearing(false);
    }
  }

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复日志查询" />;
  }
  const view = entries === undefined ? undefined : buildLogListViewModel(entries, filters);
  const expandedEntry =
    expandedId === null ? undefined : entries?.find((entry) => entry.id === expandedId);

  const busy = querying || clearing;
  const filterCount = Number(filters.type !== null) + Number(filters.level !== null);

  return (
    <div className="stm-log-tab" aria-busy={busy}>
      <PageChrome
        headerTrailing={
          <PanelBarAction
            icon="fa-trash"
            label="清空全部日志"
            danger
            data-action="clear-logs"
            disabled={busy}
            onClick={() => void clearLogs()}
          />
        }
      />
      <form
        className="stm-log-search"
        data-stm-section="log-filters"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setQueryToken((token) => token + 1);
        }}
      >
        <input
          className="stm-input"
          type="search"
          aria-label="日志 Key"
          placeholder="搜索任务 runId / 日志 Key"
          data-action="filter-log-key"
          value={filters.key}
          onChange={(event) => setFilters({ ...filters, key: event.target.value })}
        />
        <div className="stm-bar-group">
          <PanelBarAction
            type="submit"
            icon="fa-magnifying-glass"
            label={querying ? "正在查询日志" : "查询日志"}
            data-action="query-logs"
            disabled={busy}
            emphasis
          />
        </div>
      </form>
      <Disclosure
        icon="fa-filter"
        title="筛选"
        meta={filterCount > 0 ? `${filterCount} 项` : undefined}
      >
        <div className="stm-log-filters">
          <label>
            <span>类型</span>
            <select
              className="stm-select"
              data-action="filter-log-type"
              value={filters.type ?? ""}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  type: event.target.value === "" ? null : event.target.value,
                })
              }
            >
              <option value="">全部类型</option>
              {LOG_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>级别</span>
            <select
              className="stm-select"
              data-action="filter-log-level"
              value={filters.level ?? ""}
              onChange={(event) =>
                setFilters({
                  ...filters,
                  level:
                    event.target.value === ""
                      ? null
                      : (event.target.value as (typeof LEVEL_OPTIONS)[number]),
                })
              }
            >
              <option value="">全部级别</option>
              {LEVEL_OPTIONS.map((level) => (
                <option key={level} value={level}>
                  {LOG_LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Disclosure>
      <div className="stm-log-count" role="status">
        {querying ? "正在查询…" : view === undefined ? "" : `${view.length} 条`}
      </div>
      {failure !== null ? (
        <div className="stm-form-error" role="alert">
          {failure}
        </div>
      ) : null}
      {view === undefined && failure !== null ? (
        <Placeholder title="日志加载失败" hint="可重新查询" />
      ) : view === undefined ? (
        <Placeholder title="正在加载…" hint="" />
      ) : view.length === 0 ? (
        <Placeholder title="没有匹配的日志" hint="" />
      ) : (
        <ul className="stm-log-list stm-grouped-list" data-stm-section="log-list">
          {view.map((item) => (
            <li key={item.id} className="stm-log-item">
              <button
                type="button"
                className="stm-log-item-head"
                data-action="toggle-log-detail"
                data-log-id={item.id}
                aria-expanded={expandedId === item.id}
                aria-controls={expandedId === item.id ? detailId : undefined}
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <span className="stm-log-item-summary">
                  <span className="stm-log-item-title">
                    <span className="stm-log-type">{item.typeLabel}</span>
                    <span className={`stm-log-level stm-log-level--${item.level}`}>
                      {LOG_LEVEL_LABELS[item.level]}
                    </span>
                    <time className="stm-log-time">{item.timeText}</time>
                  </span>
                  <span className="stm-log-key">{item.key}</span>
                </span>
                <i
                  className={`fa-solid fa-chevron-right stm-log-chevron${expandedId === item.id ? " stm-log-chevron--open" : ""}`}
                  aria-hidden="true"
                />
              </button>
              {expandedId === item.id && expandedEntry ? (
                <div className="stm-log-detail" data-stm-section="log-detail" id={detailId}>
                  <div className="stm-log-detail-toolbar">
                    <span className="stm-log-detail-key">{item.key}</span>
                    <div className="stm-bar-group">
                      <PanelBarAction
                        icon="fa-copy"
                        label="复制日志原文"
                        data-action="copy-log"
                        onClick={() => {
                          void copyText(expandedEntry.text)
                            .then((copied) => {
                              if (copied) reportSuccess("已复制日志");
                              else reportError(new Error("复制失败"));
                            })
                            .catch(reportError);
                        }}
                      />
                    </div>
                  </div>
                  <pre className="stm-log-pre">{expandedEntry.text}</pre>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
