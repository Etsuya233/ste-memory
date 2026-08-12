/**
 * 日志 Tab（ADR 0008）：通用日志浏览——类型/级别/key 过滤、时间倒序列表、
 * 点击展开运行记录详情（块内轮时间线）、手动清空。任务面板提供「查看日志」
 * 入口跳转（focusRunId 定位到该任务的运行记录）。
 *
 * 纯逻辑在 log-panel-model（可测），本组件只做「状态 → DOM」投影与事件接线；
 * 详情渲染直接解码运行记录 data 载荷（渲染层不测，沿用任务 Tab 先例）。
 */
import { useCallback, useEffect, useState } from "react";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { LogEntry, LogRepository } from "../logging/log.ts";
import {
  FILL_RUN_LOG_TYPE,
  type FillRunRecord,
  type FillRunRound,
} from "../fill-tasks/fill-run-log.ts";
import {
  buildLogListViewModel,
  defaultLogFilters,
  FILL_RUN_STATUS_LABELS,
  LOG_LEVEL_LABELS,
  logQueryKind,
  type LogPanelFilters,
} from "./log-panel-model.ts";
import { activeStatus, Placeholder, reportError, reportSuccess } from "./ui-helpers.tsx";
import { LOG_LIMIT } from "../db/log-repository.ts";

/** 列表单次拉取上限 = 仓库全局上限：内存过滤（type/level）能命中全部保留条目 */
const LOG_PANEL_FETCH_LIMIT = LOG_LIMIT;

export interface LogTabRuntime {
  readonly logs: Pick<LogRepository, "byKey" | "bySpace" | "recent" | "clearAll">;
}

const LEVEL_OPTIONS = ["info", "warn", "error"] as const;

export function LogTab(props: {
  readonly runtime: LogTabRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 任务面板跳转定位：作为 key 过滤应用一次后消费 */
  readonly focusRunId: string | null;
  readonly onFocusConsumed: () => void;
}) {
  const active = activeStatus(props.status);
  const spaceId = active?.space.id ?? null;
  const [filters, setFilters] = useState<LogPanelFilters>(() => defaultLogFilters(spaceId));
  const [entries, setEntries] = useState<readonly LogEntry[] | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 空间切换：过滤里的空间跟随当前对话（保留用户的其他过滤条件）
  useEffect(() => {
    setFilters((current) => ({ ...current, spaceId }));
  }, [spaceId]);

  // 任务面板跳转：应用 key 过滤并消费焦点（切换 Tab 时 filter 与条目随 effect 刷新）
  useEffect(() => {
    if (props.focusRunId === null || props.focusRunId === filters.key) return;
    setFilters((current) => ({ ...current, key: props.focusRunId! }));
    props.onFocusConsumed();
  }, [props.focusRunId]);

  const refresh = useCallback(async () => {
    try {
      const kind = logQueryKind(filters);
      const base =
        kind === "key"
          ? await props.runtime.logs.byKey(filters.key.trim(), LOG_PANEL_FETCH_LIMIT)
          : kind === "space" && filters.spaceId !== null
            ? await props.runtime.logs.bySpace(filters.spaceId, LOG_PANEL_FETCH_LIMIT)
            : await props.runtime.logs.recent(LOG_PANEL_FETCH_LIMIT);
      setEntries(base);
    } catch (error) {
      reportError(error);
    }
  }, [props.runtime, filters]);

  useEffect(() => {
    void refresh();
  }, [refresh, reloadKey]);

  /** 手动清空全部日志（本地审计数据，含对话快照——用户主动入口） */
  async function clearLogs(): Promise<void> {
    try {
      await props.runtime.logs.clearAll();
      reportSuccess("已清空日志");
      setExpandedId(null);
      setReloadKey((key) => key + 1);
    } catch (error) {
      reportError(error);
    }
  }

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复日志查看" />;
  }
  const view = entries === undefined ? undefined : buildLogListViewModel(entries, filters);
  const expandedEntry = expandedId === null ? undefined : entries?.find((entry) => entry.id === expandedId);

  return (
    <div className="stm-log-tab">
      <div className="stm-task-card" data-stm-section="log-filters">
        <div className="stm-task-card-title">日志过滤</div>
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
              <option value={FILL_RUN_LOG_TYPE}>填表运行记录</option>
            </select>
          </label>
          <label className="stm-task-field">
            <span>级别</span>
            <select
              className="stm-select"
              data-action="filter-log-level"
              value={filters.level ?? ""}
              onChange={(event) =>
                setFilters({ ...filters, level: event.target.value === "" ? null : (event.target.value as (typeof LEVEL_OPTIONS)[number]) })
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
            <span>搜索 Key</span>
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
            <button type="button" className="stm-button" data-action="clear-logs" onClick={() => void clearLogs()}>
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
          <Placeholder title="没有匹配的日志" hint="调整过滤条件，或触发填表任务后回来查看" />
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
                  <span className="stm-log-key">{item.key}</span>
                  <span className="stm-log-summary">{item.summary || item.type}</span>
                  <span className="stm-log-time">{item.timeText}</span>
                </button>
                {expandedId === item.id && expandedEntry ? (
                  <div className="stm-log-detail" data-stm-section="log-detail">
                    <LogDetail entry={expandedEntry} />
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

/** 详情渲染：fill 类型解码运行记录（块/轮时间线）；未知类型展示原始载荷。 */
function LogDetail(props: { readonly entry: LogEntry }) {
  const { entry } = props;
  if (entry.type !== FILL_RUN_LOG_TYPE) {
    return <pre className="stm-log-pre">{JSON.stringify(entry.data, null, 2)}</pre>;
  }
  const run = entry.data as FillRunRecord;
  return (
    <div className="stm-log-run">
      <div className="stm-log-run-head">
        楼层 {run.block.from}–{run.block.to} · {FILL_RUN_STATUS_LABELS[run.status] ?? run.status}
        {run.errorMessage ? <span className="stm-history-error">{run.errorMessage}</span> : null}
        <span className="stm-log-time">
          {run.startedAt} → {run.endedAt}（{run.durationMs}ms）
        </span>
      </div>
      <details className="stm-log-details">
        <summary>系统提示词（{run.systemPrompt.length} 字符）</summary>
        <pre className="stm-log-pre">{run.systemPrompt}</pre>
      </details>
      <details className="stm-log-details">
        <summary>逐轮调用（{run.rounds.length} 轮）</summary>
        {run.rounds.map((round, index) => (
          <RoundDetail key={index} index={index} round={round} />
        ))}
      </details>
    </div>
  );
}

function RoundDetail(props: { readonly index: number; readonly round: FillRunRound }) {
  const { index, round } = props;
  const text = Array.isArray(round.output.content)
    ? round.output.content
        .filter((block) => block !== null && typeof block === "object" && "text" in block)
        .map((block) => (block as { readonly text?: unknown }).text ?? "")
        .join("")
    : "";
  const toolCalls = Array.isArray(round.output.content)
    ? round.output.content.filter(
        (block) => block !== null && typeof block === "object" && "name" in block,
      )
    : [];
  const usage = round.output.usage as
    | { readonly totalTokens?: number; readonly input?: number; readonly output?: number }
    | undefined;
  return (
    <div className="stm-log-round">
      <div className="stm-log-round-head">
        第 {index + 1} 轮 · {round.output.stopReason ?? "未完成"}
        {usage && typeof usage.totalTokens === "number"
          ? ` · tokens ${usage.totalTokens}（入 ${usage.input ?? 0} / 出 ${usage.output ?? 0}）`
          : ""}
        {round.output.errorMessage ? (
          <span className="stm-history-error">{round.output.errorMessage}</span>
        ) : null}
      </div>
      <details className="stm-log-details">
        <summary>请求消息（{Array.isArray(round.request.messages) ? round.request.messages.length : "?"} 条）</summary>
        <pre className="stm-log-pre">
          {JSON.stringify(round.request.messages, null, 2)}
        </pre>
      </details>
      {toolCalls.length > 0 ? (
        <details className="stm-log-details">
          <summary>工具调用（{toolCalls.length} 个）</summary>
          <pre className="stm-log-pre">{JSON.stringify(toolCalls, null, 2)}</pre>
        </details>
      ) : null}
      {round.toolResults.length > 0 ? (
        <details className="stm-log-details">
          <summary>工具结果（{round.toolResults.length} 个）</summary>
          <ul className="stm-log-tool-results">
            {round.toolResults.map((result, resultIndex) => (
              <li key={resultIndex}>
                <span className={`stm-log-level stm-log-level--${result.isError ? "error" : "info"}`}>
                  {result.isError ? "错误" : "成功"}
                </span>
                <code>{result.toolName}</code>
                <pre className="stm-log-pre">
                  {JSON.stringify({ args: result.args, result: result.result }, null, 2)}
                </pre>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {text !== "" ? (
        <details className="stm-log-details" open>
          <summary>模型回答</summary>
          <pre className="stm-log-pre">{text}</pre>
        </details>
      ) : null}
    </div>
  );
}
