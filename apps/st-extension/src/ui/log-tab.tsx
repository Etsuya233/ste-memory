/**
 * 日志 Tab（ADR 0015）：纯查询页——类型/级别/Key 过滤、「查询」按钮刷新、时间
 * 倒序结果列表、点击单条原样展开文本（`<pre>`，同一时间只展开一条）、清空日志。
 * 任务面板提供「日志」入口跳转（focusRunId 作为 Key 过滤并立即查询一次）。
 *
 * 纯逻辑在 log-panel-model（可测），本组件只做「状态 → DOM」投影与事件接线；
 * 查询侧零业务解析：文本原样展示，不做类型专属摘要、状态解码或结构折叠。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { LogEntry, LogRepository } from "../logging/log.ts";
import {
  buildLogListViewModel,
  defaultLogFilters,
  LOG_LEVEL_LABELS,
  LOG_TYPE_OPTIONS,
  logQueryKind,
  type LogPanelFilters,
} from "./log-panel-model.ts";
import { Placeholder, reportError, reportSuccess } from "./ui-helpers.tsx";
import { LOG_LIMIT } from "../db/log-repository.ts";

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
  // 查询只在进入页面/点「查询」/任务跳转时执行；用 ref 读取最新过滤状态，
  // 使 refresh 的标识稳定（过滤输入本身不触发重新查询）。
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const refresh = useCallback(async () => {
    const current = filtersRef.current;
    try {
      const base =
        logQueryKind(current) === "key"
          ? await props.runtime.logs.byKey(current.key.trim(), LOG_PANEL_FETCH_LIMIT)
          : await props.runtime.logs.recent(LOG_PANEL_FETCH_LIMIT);
      setEntries(base);
    } catch (error) {
      reportError(error);
    }
  }, [props.runtime]);

  // 进入页面自动执行一次；「查询」按钮/任务跳转经 queryToken 显式刷新
  useEffect(() => {
    void refresh();
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
    try {
      await props.runtime.logs.clearAll();
      reportSuccess("已清空日志");
      setExpandedId(null);
      setQueryToken((token) => token + 1);
    } catch (error) {
      reportError(error);
    }
  }

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复日志查询" />;
  }
  const view = entries === undefined ? undefined : buildLogListViewModel(entries, filters);
  const expandedEntry =
    expandedId === null ? undefined : entries?.find((entry) => entry.id === expandedId);

  return (
    <div className="stm-log-tab">
      <div className="stm-task-card" data-stm-section="log-filters">
        <div className="stm-task-card-title">日志查询</div>
        <div className="stm-task-form">
          <label className="stm-task-field">
            <span>类型</span>
            <select
              className="stm-select"
              data-action="filter-log-type"
              value={filters.type ?? ""}
              onChange={(event) =>
                setFilters({ ...filters, type: event.target.value === "" ? null : event.target.value })
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
          <label className="stm-task-field">
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
          <label className="stm-task-field stm-task-field--grow">
            <span>Key</span>
            <input
              className="stm-input"
              type="text"
              placeholder="任务 runId / 日志 key"
              data-action="filter-log-key"
              value={filters.key}
              onChange={(event) => setFilters({ ...filters, key: event.target.value })}
            />
          </label>
          <div className="stm-task-actions">
            <button
              type="button"
              className="stm-button stm-button--primary"
              data-action="query-logs"
              onClick={() => setQueryToken((token) => token + 1)}
            >
              查询
            </button>
            <button
              type="button"
              className="stm-button"
              data-action="clear-logs"
              onClick={() => void clearLogs()}
            >
              清空日志
            </button>
          </div>
        </div>
      </div>
      {view === undefined ? (
        <div className="stm-task-card">
          <Placeholder title="正在加载…" hint="" />
        </div>
      ) : view.length === 0 ? (
        <div className="stm-task-card">
          <Placeholder title="没有匹配的日志" hint="调整过滤条件，或触发填表任务后回来查询" />
        </div>
      ) : (
        <div className="stm-task-card" data-stm-section="log-list">
          <div className="stm-task-card-title">日志（{view.length} 条）</div>
          <ul className="stm-log-list">
            {view.map((item) => (
              <li key={item.id} className="stm-log-item">
                <button
                  type="button"
                  className="stm-log-item-head"
                  data-action="toggle-log-detail"
                  data-log-id={item.id}
                  onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                >
                  <span className={`stm-log-level stm-log-level--${item.level}`}>
                    {LOG_LEVEL_LABELS[item.level]}
                  </span>
                  <span className="stm-log-type">{item.typeLabel}</span>
                  <span className="stm-log-key">{item.key}</span>
                  <span className="stm-log-time">{item.timeText}</span>
                </button>
                {expandedId === item.id && expandedEntry ? (
                  <div className="stm-log-detail" data-stm-section="log-detail">
                    <pre className="stm-log-pre">{expandedEntry.text}</pre>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
