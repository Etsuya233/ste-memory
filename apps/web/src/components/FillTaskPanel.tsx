import { LoaderCircle, Pause, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cancelFillTask,
  fetchActiveFillTask,
  fetchFillTaskCoverage,
  pauseFillTask,
  resumeFillTask,
  submitFillTask,
  subscribeFillTaskEvents,
  type FillTask,
  type FillTaskCoverage,
} from "../api/fill-tasks.ts";
import { loadPersistedLlmConfig } from "../api/chat.ts";
import type { MemorySpace } from "../api/memory-spaces.ts";
import {
  availableFillTaskControls,
  STATUS_META,
  type FillTaskControlAction,
} from "../fill-task-panel-state.ts";
import {
  appendFillTaskEvents,
  createFillTaskLog,
  type FillTaskLogState,
} from "../fill-task-events-state.ts";
import { FillTaskCoverageMatrix } from "./FillTaskCoverageMatrix.tsx";
import { FillTaskLogView } from "./FillTaskLogView.tsx";
import { FillTaskSubmitForm } from "./FillTaskSubmitForm.tsx";
import { Badge, Button } from "../ui.tsx";

interface FillTaskPanelProps {
  readonly space: MemorySpace;
}

/** 默认分块大小：与服务端 DEFAULT_FILL_TASK_BLOCK_SIZE 保持一致。 */
const DEFAULT_BLOCK_SIZE = 20;
/** 活动任务状态轮询间隔（服务端控制请求最迟在安全点生效，秒级可见）。 */
const ACTIVE_POLL_INTERVAL_MS = 2_000;
/** 事件流断线后的重连间隔（Last-Event-ID 续传；轮询仍兜底状态）。 */
const EVENT_RETRY_INTERVAL_MS = 2_000;

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
 * 填表任务面板（ticket 13/14/16/17）：选闭区间 [from, to] + 分块大小提交后台任务；
 * 运行期间轮询状态并支持暂停/恢复/中止（pendingAction 防重复提交）；SSE 实时日志
 * 断线自动重连（Last-Event-ID 续传）；覆盖矩阵展示全部消息四态，随轮询实时推进。
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
  // 覆盖视图（ticket 17）：全部消息四态分类；有活动任务时随轮询刷新。
  const [coverage, setCoverage] = useState<FillTaskCoverage | null>(null);
  const hasActiveTask = active !== null;
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

  // 切换空间：清空日志与覆盖矩阵，避免残留上一个空间的运行输出/状态。
  useEffect(() => {
    setLog(createFillTaskLog());
    setCoverage(null);
  }, [space.id]);

  // 覆盖视图：挂载/切换空间立即拉取；有活动任务时每 2s 刷新（进度实时推进）；
  // 任务提交（active 变非空）或终态（变 null）时立即刷新一次。
  useEffect(() => {
    let cancelled = false;
    void fetchFillTaskCoverage(space.id)
      .then((result) => {
        if (!cancelled) setCoverage(result);
      })
      .catch(() => undefined);
    if (!hasActiveTask) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => {
      void fetchFillTaskCoverage(space.id)
        .then((result) => {
          if (!cancelled) setCoverage(result);
        })
        .catch(() => undefined);
    }, ACTIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [space.id, hasActiveTask]);

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

      {coverage ? <FillTaskCoverageMatrix states={coverage.states} /> : null}

      {log.entries.length > 0 ? <FillTaskLogView log={log} /> : null}

      <FillTaskSubmitForm
        messageCount={space.messageCount}
        from={from}
        to={to}
        blockSize={blockSize}
        busy={busy}
        blocked={blocked}
        onFromChange={setFrom}
        onToChange={setTo}
        onBlockSizeChange={setBlockSize}
        onSubmit={() => void submit()}
      />

      {lastResult ? <p className="fill-task-result">✓ {lastResult}</p> : null}
      {error ? <p className="form-error fill-task-error">{error}</p> : null}

      <div className="fill-task-readonly-note">
        LLM 配置沿用 Agent 聊天面板中保存在本地的值；任务运行期间该空间会被服务端锁定为只读。
        暂停/中止在安全点生效：正在处理的整块消息完成后才生效，不会打断进行中的请求或写入。
      </div>
    </div>
  );
}
