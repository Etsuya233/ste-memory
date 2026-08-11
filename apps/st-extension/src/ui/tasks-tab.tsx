/**
 * 任务 Tab（ticket 13 触发 UI + ticket 14 任务面板）：手动指定楼层范围触发填表任务、
 * 逐消息覆盖视图、运行中任务取消、失败/中断任务重试、任务历史列表。
 *
 * 纯逻辑在 task-panel-model（可测），本组件只做「状态 → DOM」投影与事件接线：
 * - 覆盖视图：楼层条（每消息一格，已处理/任务中/出错/未计划）+ 图例计数；
 * - 触发表单：from/to 楼层输入（预填首个未处理范围）+ 触发按钮；输入校验错误内联展示；
 * - 活动任务区：状态/范围/进度 + 取消（用户取消 = 与关 tab 同态落 interrupted）；
 * - 任务历史：终态任务列表（状态/范围/时间/错误），失败与中断可重试；
 * - 数据轮询：本票无事件总线（ticket 16 引入），有活动任务时每 1s 刷新进度。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FloorLedgerEntry } from "../fill-tasks/fill-task.ts";
import type { FillTaskService } from "../fill-tasks/fill-task-service.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import type { PluginSettings, SettingsStore } from "../settings/plugin-settings.ts";
import {
  BUILTIN_AGENT_PRESET_ID,
  setActiveAgentPreset,
} from "../agent-presets/preset-model.ts";
import {
  buildTasksTabViewModel,
  COVERAGE_STATUS_LABELS,
  validateFloorRange,
  type CoverageStatus,
  type TasksTabViewModel,
} from "./task-panel-model.ts";
import { activeStatus, Placeholder, reportError, reportSuccess } from "./ui-helpers.tsx";

/** 轮询间隔：任务运行期进度刷新（无事件总线时的 v1 方案） */
const TASK_POLL_INTERVAL_MS = 1_000;

/** 任务历史拉取上限（终态任务列表；运行中任务在活动任务区展示，不占历史名额） */
const TASK_HISTORY_LIMIT = 20;

/** 覆盖类别 → 计数视图字段（图例展示；数组顺序 = 图例顺序，与 ticket 文案一致）。 */
const COVERAGE_LEGEND_ITEMS: readonly {
  readonly status: CoverageStatus;
  readonly countField: "processedCount" | "runningCount" | "errorCount" | "untrackedCount";
}[] = [
  { status: "processed", countField: "processedCount" },
  { status: "running", countField: "runningCount" },
  { status: "error", countField: "errorCount" },
  { status: "untracked", countField: "untrackedCount" },
];

export interface TasksTabRuntime {
  readonly tasks: Pick<
    FillTaskService,
    "submit" | "cancel" | "retry" | "activeTask" | "recentTasks" | "ledgerStatuses"
  >;
  readonly st: { readonly chatMessageCount: () => number };
  /** 设置写入（ticket 17：任务 Tab 快捷切换活动预设） */
  readonly settings: Pick<SettingsStore, "write">;
}

export function TasksTab(props: {
  readonly runtime: TasksTabRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  readonly onSettingsChange: (settings: PluginSettings) => void;
}) {
  const active = activeStatus(props.status);
  const spaceId = active?.space.id;
  const [view, setView] = useState<TasksTabViewModel | undefined>(undefined);
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 表单预填标记（按空间记录：切换空间后重新预填未处理范围）
  const prefilledSpaceRef = useRef<string | undefined>(undefined);
  // 轮询定时器句柄（活动任务期间每 1s 重取；卸载/空间切换清理）
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!spaceId) {
      setView(undefined);
      return;
    }
    try {
      const chatLength = props.runtime.st.chatMessageCount();
      const [ledger, activeTask, recent] = await Promise.all([
        chatLength > 0
          ? props.runtime.tasks.ledgerStatuses(spaceId, 0, chatLength - 1)
          : Promise.resolve<readonly FloorLedgerEntry[]>([]),
        props.runtime.tasks.activeTask(spaceId),
        props.runtime.tasks.recentTasks(spaceId, TASK_HISTORY_LIMIT),
      ]);
      const next = buildTasksTabViewModel({
        chatLength,
        ledger,
        activeTask,
        historyTasks: recent,
      });
      // 每个空间首次载入时把表单预填为未处理范围（预填标记随空间走，
      // 用户改过输入后不再覆盖；预填放在 updater 外，updater 保持纯函数）
      if (prefilledSpaceRef.current !== spaceId) {
        prefilledSpaceRef.current = spaceId;
        if (next.defaultFrom !== "") {
          setFromText(next.defaultFrom);
          setToText(next.defaultTo);
        }
      }
      setView(next);
    } catch (error) {
      reportError(error);
    }
  }, [props.runtime, spaceId]);

  // 载入与空间切换重取；活动任务期间轮询
  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current !== undefined) clearInterval(pollRef.current);
      pollRef.current = undefined;
    };
  }, [refresh, reloadKey]);

  useEffect(() => {
    if (pollRef.current !== undefined) clearInterval(pollRef.current);
    if (view?.hasActiveTask) {
      pollRef.current = setInterval(() => void refresh(), TASK_POLL_INTERVAL_MS);
    } else {
      pollRef.current = undefined;
    }
  }, [view?.hasActiveTask, refresh]);

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复任务触发" />;
  }
  // Agent 预设快捷切换（ticket 17）：全局配置，不依赖空间状态/任务视图，
  // 任何状态都渲染（无空间/加载中也能切换活动预设）
  const presetSwitcher = (
    <div className="stm-task-card" data-stm-section="preset">
      <div className="stm-task-card-title">Agent 预设</div>
      <div className="stm-task-form">
        <label className="stm-task-field stm-task-field--grow">
          <span>当前预设</span>
          <select
            className="stm-select"
            data-action="select-agent-preset"
            value={props.settings.agentPresets.activePresetId}
            onChange={(event) => selectPreset(event.target.value)}
          >
            <option value={BUILTIN_AGENT_PRESET_ID}>系统默认</option>
            {props.settings.agentPresets.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
  if (!active) {
    return (
      <div className="stm-task-tab">
        {presetSwitcher}
        <Placeholder
          title={props.status && props.status.kind !== "active" ? props.status.humanMsg : "正在加载…"}
          hint="切换到已保存的对话后自动恢复"
        />
      </div>
    );
  }
  if (!view) {
    return <div className="stm-task-tab">{presetSwitcher}</div>;
  }
  // 守卫后的窄化常量：闭包内不依赖 TS 对联合类型收窄的保留
  const currentSpaceId = active.space.id;

  /** 快捷切换活动预设（写 settings；破限流程「切预设→触发」不打断） */
  function selectPreset(presetId: string): void {
    const next = {
      ...props.settings,
      agentPresets: setActiveAgentPreset(props.settings.agentPresets, presetId),
    };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
  }

  /** 触发填表：校验楼层输入（可读错误内联展示）→ 提交（冲突/LLM 缺失经 toastr） */
  async function trigger(): Promise<void> {
    const validation = validateFloorRange(fromText, toText, view!.chatLength);
    if (validation.kind === "error") {
      setInputError(validation.message);
      return;
    }
    setInputError(null);
    try {
      await props.runtime.tasks.submit({
        memorySpaceId: currentSpaceId,
        from: validation.from,
        to: validation.to,
      });
      reportSuccess(`已触发填表任务（楼层 ${validation.from}–${validation.to}）`);
      setReloadKey((key) => key + 1);
    } catch (error) {
      reportError(error);
    }
  }

  /** 取消运行中任务：立即落 interrupted（与关 tab 同态，不自动重放） */
  async function cancelActive(): Promise<void> {
    const runId = view?.activeTaskRunId;
    if (!runId) return;
    try {
      await props.runtime.tasks.cancel(currentSpaceId, runId);
      reportSuccess("已取消填表任务");
      setReloadKey((key) => key + 1);
    } catch (error) {
      reportError(error);
    }
  }

  /** 失败/中断任务重试：按原楼层范围重新提交为新任务（原任务保留在历史） */
  async function retryTask(runId: string): Promise<void> {
    try {
      await props.runtime.tasks.retry(currentSpaceId, runId);
      reportSuccess("已重新触发填表任务");
      setReloadKey((key) => key + 1);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <div className="stm-task-tab">
      {presetSwitcher}
      {view.coverage.totalCount > 0 ? (
        <div className="stm-task-card" data-stm-section="coverage">
          <div className="stm-task-card-title">楼层覆盖</div>
          {/* 楼层条：每消息一格（run 为渲染单元展开，键 = 楼层号），悬停显示楼层与类别 */}
          <div
            className="stm-coverage-strip"
            data-stm-field="coverage-strip"
            aria-label="楼层覆盖条"
          >
            {view.coverage.runs.flatMap((run) => {
              const cells: ReactNode[] = [];
              for (let floor = run.from; floor <= run.to; floor += 1) {
                cells.push(
                  <span
                    key={floor}
                    className={`stm-coverage-cell stm-coverage-cell--${run.status}`}
                    title={`#${floor} · ${COVERAGE_STATUS_LABELS[run.status]}`}
                  />,
                );
              }
              return cells;
            })}
          </div>
          <div className="stm-coverage-legend">
            {COVERAGE_LEGEND_ITEMS.map(({ status, countField }) => (
              <span
                key={status}
                className="stm-coverage-legend-item"
                data-stm-field={`coverage-${status}`}
              >
                <span
                  className={`stm-coverage-dot stm-coverage-dot--${status}`}
                  aria-hidden="true"
                />
                {COVERAGE_STATUS_LABELS[status]} {view.coverage[countField]}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {view.hasActiveTask && view.activeTaskRunId ? (
        <div className="stm-task-card" data-stm-section="active-task">
          <div className="stm-task-card-title">
            {view.activeTaskLabel} · {view.activeRange}
          </div>
          <div className="stm-task-card-detail">{view.activeTaskDetail}</div>
          <div className="stm-task-actions">
            <button
              type="button"
              className="stm-button"
              data-action="cancel-task"
              onClick={() => void cancelActive()}
            >
              取消任务
            </button>
          </div>
        </div>
      ) : (
        <div className="stm-task-card" data-stm-section="trigger">
          <div className="stm-task-card-title">手动触发填表</div>
          {view.unprocessedHint ? (
            <div className="stm-task-hint" data-stm-field="unprocessed-hint">
              {view.unprocessedHint}
            </div>
          ) : (
            <div className="stm-task-hint">全部楼层已处理；重新触发可覆盖旧数据</div>
          )}
          <div className="stm-task-form">
            <label className="stm-task-field">
              <span>楼层</span>
              <input
                type="text"
                inputMode="numeric"
                data-stm-field="range-from"
                value={fromText}
                placeholder="起始（从 0 开始）"
                onChange={(event) => {
                  setFromText(event.target.value);
                  setInputError(null);
                }}
              />
            </label>
            <span className="stm-task-range-sep">–</span>
            <label className="stm-task-field">
              <input
                type="text"
                inputMode="numeric"
                data-stm-field="range-to"
                value={toText}
                placeholder="结束"
                onChange={(event) => {
                  setToText(event.target.value);
                  setInputError(null);
                }}
              />
            </label>
            <button
              type="button"
              className="stm-button stm-button--primary"
              data-action="trigger-fill-task"
              disabled={!view.canTrigger}
              onClick={() => void trigger()}
            >
              触发填表
            </button>
          </div>
          {inputError ? (
            <div className="stm-task-error" data-stm-field="range-error">
              {inputError}
            </div>
          ) : null}
        </div>
      )}
      {view.history.length > 0 ? (
        <div className="stm-task-card" data-stm-section="history">
          <div className="stm-task-card-title">任务历史</div>
          <ul className="stm-history-list">
            {view.history.map((item) => (
              <li key={item.runId} className="stm-history-item">
                <div className="stm-history-head">
                  <span className={`stm-task-status stm-task-status--${item.status}`}>
                    {item.statusLabel}
                  </span>
                  <span className="stm-history-range">{item.rangeText}</span>
                  <span className="stm-history-time">{item.timeText}</span>
                </div>
                <div className="stm-history-detail">{item.progressText}</div>
                {item.errorMessage ? (
                  <div className="stm-history-error" data-stm-field="task-error">
                    {item.errorMessage}
                  </div>
                ) : null}
                {item.retryable ? (
                  <div className="stm-task-actions">
                    <button
                      type="button"
                      className="stm-button"
                      data-action="retry-task"
                      data-run-id={item.runId}
                      onClick={() => void retryTask(item.runId)}
                    >
                      重试
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.noMessages ? (
        <Placeholder title="当前对话没有消息" hint="发送消息后即可触发填表" />
      ) : null}
    </div>
  );
}
