import { Activity, CircleAlert, LoaderCircle, Pause, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cancelFillTask,
  fetchActiveFillTask,
  isFillTaskTerminal,
  pauseFillTask,
  resumeFillTask,
  submitFillTask,
  subscribeFillTaskEvents,
  type FillTask,
  type FillTaskStatus,
} from "../api/fill-tasks.ts";
import { loadPersistedLlmConfig } from "../api/chat.ts";
import type { MemorySpace } from "../api/memory-spaces.ts";
import { availableFillTaskControls, type FillTaskControlAction } from "../fill-task-panel-state.ts";
import {
  appendFillTaskEvents,
  buildFillTaskTimeline,
  createFillTaskLog,
  latestTaskStatus,
  type FillTaskLogState,
  type FillTaskTimelineItem,
} from "../fill-task-events-state.ts";
import { ToolCallCardView } from "./AgentActivityView.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Badge, Button, Field, TextInput, type BadgeTone } from "../ui.tsx";

interface FillTaskPanelProps {
  readonly space: MemorySpace;
}

/** 默认分块大小：与服务端 DEFAULT_FILL_TASK_BLOCK_SIZE 保持一致。 */
const DEFAULT_BLOCK_SIZE = 20;
/** 活动任务状态轮询间隔（服务端控制请求最迟在安全点生效，秒级可见）。 */
const ACTIVE_POLL_INTERVAL_MS = 2_000;
/** 事件流断线后的重连间隔（Last-Event-ID 续传；轮询仍兜底状态）。 */
const EVENT_RETRY_INTERVAL_MS = 2_000;

/** 状态展示元数据：文案 / 徽标色调 / 是否转圈（任务仍在推进）。 */
const STATUS_META: Record<
  FillTaskStatus,
  { readonly label: string; readonly tone: BadgeTone; readonly busy: boolean }
> = {
  queued: { label: "排队中", tone: "accent", busy: true },
  running: { label: "运行中", tone: "accent", busy: true },
  pause_requested: { label: "暂停请求中", tone: "accent", busy: true },
  paused: { label: "已暂停", tone: "neutral", busy: false },
  cancel_requested: { label: "正在中止", tone: "accent", busy: true },
  cancelled: { label: "已中止", tone: "warn", busy: false },
  succeeded: { label: "已完成", tone: "accent", busy: false },
  failed: { label: "失败", tone: "danger", busy: false },
  interrupted: { label: "已中断", tone: "warn", busy: false },
};

const CONTROL_META: Record<
  FillTaskControlAction,
  {
    readonly label: string;
    readonly variant: "primary" | "secondary" | "danger";
    readonly icon: typeof Pause;
    readonly run: (spaceId: string, runId: string) => Promise<FillTask>;
  }
> = {
  pause: { label: "暂停", variant: "secondary", icon: Pause, run: pauseFillTask },
  resume: { label: "恢复", variant: "primary", icon: Play, run: resumeFillTask },
  cancel: { label: "中止", variant: "danger", icon: Square, run: cancelFillTask },
};

function formatUpdatedAt(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return updatedAt;
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * 填表任务面板（ticket 13/14/16）：选择消息闭区间 [from, to] 与分块大小提交后台任务；
 * 任务运行期间轮询完整状态（状态/进度/最近更新），支持暂停、恢复、中止——
 * 请求中（pendingAction）禁用全部控制，避免重复提交；终态后回到表单可再次提交。
 * 任务运行期间通过 SSE 事件流实时展示 Agent 输出（思考、工具调用、块结果），
 * 断线自动重连（Last-Event-ID 续传），轮询兜底状态。
 */
export function FillTaskPanel({ space }: FillTaskPanelProps) {
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(space.messageCount);
  const [blockSize, setBlockSize] = useState(DEFAULT_BLOCK_SIZE);
  const [active, setActive] = useState<FillTask | null>(null);
  const [pendingAction, setPendingAction] = useState<FillTaskControlAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastResult, setLastResult] = useState<string>();
  // 实时运行日志（ticket 16）：事件流按 seq 追加；轮询与流各自驱动，流到达的终态优先。
  const [log, setLog] = useState<FillTaskLogState>(createFillTaskLog);
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    setFrom(1);
    setTo(space.messageCount);
    setError(undefined);
    setLastResult(undefined);
    let cancelled = false;
    void fetchActiveFillTask(space.id)
      .then((task) => {
        if (!cancelled) setActive(task);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [space.id, space.messageCount]);

  // 任务运行期间轮询活动状态（状态/进度/最近更新时间），结束后自动收起横幅。
  useEffect(() => {
    if (!active) return;
    pollTimer.current = setInterval(() => {
      void fetchActiveFillTask(space.id)
        .then((task) => {
          setActive(task);
          // 终态（active 为 null）时清掉未决请求状态，面板回到可提交表单。
          if (!task) setPendingAction(null);
        })
        .catch(() => undefined);
    }, ACTIVE_POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [active, space.id]);

  // 切换空间：清空日志，避免残留上一个空间的运行输出。
  useEffect(() => {
    setLog(createFillTaskLog());
  }, [space.id]);

  // 任务运行期间订阅事件流：断线自动重连（Last-Event-ID 续传）；
  // 切换任务/空间或组件卸载时中止；任务终态由流中的 task_status 表达。
  useEffect(() => {
    const runId = active?.runId;
    if (!runId) return;
    const controller = new AbortController();
    let lastEventId: number | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = async () => {
      try {
        await subscribeFillTaskEvents(space.id, runId, lastEventId, controller.signal, (entry) => {
          lastEventId = entry.seq;
          setLog((current) => appendFillTaskEvents(current, [entry]));
        });
      } catch {
        if (controller.signal.aborted || closed) return;
        // 断线/服务端错误：稍后重连（续传不丢事件）；轮询仍兜底任务状态。
        retryTimer = setTimeout(() => void connect(), EVENT_RETRY_INTERVAL_MS);
      }
    };
    void connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
    };
  }, [active?.runId, space.id]);

  async function submit() {
    setBusy(true);
    setError(undefined);
    setLastResult(undefined);
    try {
      const task = await submitFillTask(space.id, {
        from,
        to,
        blockSize,
        config: loadPersistedLlmConfig(),
      });
      setActive(task);
      setLog(createFillTaskLog());
      setLastResult(
        `任务已提交：${task.runId}（${task.from}–${task.to}，块大小 ${task.blockSize}）`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交任务失败");
    } finally {
      setBusy(false);
    }
  }

  async function runControl(action: FillTaskControlAction) {
    if (!active) return;
    setPendingAction(action);
    setError(undefined);
    try {
      const task = await CONTROL_META[action].run(space.id, active.runId);
      setActive(task);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setPendingAction(null);
    }
  }

  const rangeInvalid = from < 1 || to < from || to > space.messageCount;
  const blocked = active !== null;
  const controls = active ? availableFillTaskControls(active.status, pendingAction) : [];

  return (
    <div className="fill-task-panel">
      <header className="tool-panel-heading">
        <div>
          <h3>后台填表任务</h3>
          <p>在「{space.name}」的消息区间内，由 Agent 批量提取结构化记忆写入各表格。</p>
        </div>
        <Badge tone="neutral">{space.messageCount} 条消息</Badge>
      </header>

      {active ? (
        <div className="fill-task-active">
          {STATUS_META[active.status].busy ? <LoaderCircle size={15} className="spinning" /> : null}
          <div>
            <strong>
              {STATUS_META[active.status].label}
              {pendingAction !== null ? "（请求中）" : ""}
            </strong>
            <span>
              {active.runId.slice(0, 8)} · 消息 {active.from}–{active.to} · 块大小{" "}
              {active.blockSize}
            </span>
            <span>
              已处理 {active.processedCount}/{active.totalCount} · 更新于{" "}
              {formatUpdatedAt(active.updatedAt)}
            </span>
          </div>
          <Badge tone={STATUS_META[active.status].tone}>
            {active.processedCount}/{active.totalCount}
          </Badge>
          <em>该空间任务期间只读</em>
          <div className="fill-task-controls">
            {controls.map((action) => {
              const meta = CONTROL_META[action];
              const Icon = meta.icon;
              return (
                <Button
                  key={action}
                  size="sm"
                  variant={meta.variant}
                  icon={<Icon size={13} />}
                  disabled={pendingAction !== null}
                  onClick={() => void runControl(action)}
                >
                  {meta.label}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}

      {log.entries.length > 0 ? <FillTaskLogView log={log} /> : null}

      <form
        className="fill-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="fill-task-grid">
          <Field label="消息范围" hint={`共 ${space.messageCount} 条`} htmlFor="fill-from">
            <div className="fill-task-range">
              <TextInput
                id="fill-from"
                type="number"
                min={1}
                max={space.messageCount}
                value={Number.isFinite(from) ? from : ""}
                onChange={(event) => setFrom(event.target.valueAsNumber)}
                aria-label="起始消息"
              />
              <i>至</i>
              <TextInput
                id="fill-to"
                type="number"
                min={1}
                max={space.messageCount}
                value={Number.isFinite(to) ? to : ""}
                onChange={(event) => setTo(event.target.valueAsNumber)}
                aria-label="结束消息"
              />
            </div>
          </Field>
          <Field label="分块大小" hint="每条消息单独写入" htmlFor="fill-block">
            <TextInput
              id="fill-block"
              type="number"
              min={1}
              value={Number.isFinite(blockSize) ? blockSize : ""}
              onChange={(event) => setBlockSize(event.target.valueAsNumber)}
              aria-label="分块大小"
            />
          </Field>
          <Field
            label="提交任务"
            hint={blocked ? "已有任务运行中" : undefined}
            htmlFor="fill-submit"
          >
            <Button
              className="fill-task-submit"
              variant="primary"
              type="submit"
              block
              icon={<Play size={14} />}
              disabled={busy || blocked || rangeInvalid}
            >
              开始填表
            </Button>
          </Field>
        </div>
        {rangeInvalid ? (
          <p className="fill-task-hint">
            <CircleAlert size={12} /> 范围需在 [1, {space.messageCount}] 内
          </p>
        ) : null}
      </form>

      {lastResult ? <p className="fill-task-result">✓ {lastResult}</p> : null}
      {error ? <p className="form-error fill-task-error">{error}</p> : null}

      <div className="fill-task-readonly-note">
        LLM 配置沿用 Agent 聊天面板中保存在本地的值；任务运行期间该空间会被服务端锁定为只读。
        暂停/中止在安全点生效：正在处理的整块消息完成后才生效，不会打断进行中的请求或写入。
      </div>
    </div>
  );
}

/**
 * 实时运行日志（ticket 16）：块进度 + 思考/工具调用（共享 AgentActivityView 渲染）+
 * 块结果摘要 + 任务状态。日志随事件流增长，终态后保留在页面上。
 */
function FillTaskLogView({ log }: { log: FillTaskLogState }) {
  const listRef = useRef<HTMLDivElement>(null);
  const timeline = buildFillTaskTimeline(log.entries);
  const status = latestTaskStatus(log);
  const ended = status !== undefined && isFillTaskTerminal(status.status);

  // 新事件自动滚到底部。
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [log.entries.length]);

  return (
    <div className="fill-task-log">
      <header className="fill-task-log-heading">
        <Activity size={13} />
        <span>实时运行日志</span>
        {!ended ? <LoaderCircle size={12} className="spinning" /> : null}
        {status ? (
          <em>
            {STATUS_META[status.status].label}
            {status.errorMessage ? `：${status.errorMessage}` : ""}
          </em>
        ) : null}
      </header>
      <div className="fill-task-log-list" ref={listRef}>
        {(() => {
          let blockIndex = 0;
          return timeline.map((item, index) => {
            if (item.kind === "block_start") blockIndex += 1;
            return (
              <FillTaskLogItemView
                key={index}
                item={item}
                running={!ended}
                blockIndex={item.kind === "block_start" ? blockIndex : undefined}
              />
            );
          });
        })()}
      </div>
    </div>
  );
}

function FillTaskLogItemView({
  item,
  running,
  blockIndex,
}: {
  item: FillTaskTimelineItem;
  running: boolean;
  blockIndex?: number;
}) {
  switch (item.kind) {
    case "thinking":
      return (
        <details className="thinking-block" open={running}>
          <summary>思考过程</summary>
          <MarkdownContent text={item.text} />
        </details>
      );
    case "tool":
      // 时间线 tool 项与聊天 ToolCallCard 同构（callId/name/args/result/isError）。
      return <ToolCallCardView card={item} />;
    case "block_start":
      return (
        <div className="fill-task-log-block">
          <strong>第 {blockIndex ?? "?"} 块</strong>
          <span>
            消息 {item.from}–{item.to}
          </span>
        </div>
      );
    case "block_done":
      return (
        <div className="fill-task-log-block-done">
          <span>
            ✓ 消息 {item.from}–{item.to}
          </span>
          <em>
            {item.emptyProposal ? "空提案（无需变更）" : `变更 ${item.changedRecords} 条记录`}
          </em>
        </div>
      );
    case "status":
      return (
        <div className={`fill-task-log-status ${running ? "" : "fill-task-log-status-terminal"}`}>
          {STATUS_META[item.status].label}
          {item.errorMessage ? `：${item.errorMessage}` : ""}
        </div>
      );
  }
}
