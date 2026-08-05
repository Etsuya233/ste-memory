import { CircleAlert, LoaderCircle, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchActiveFillTask, submitFillTask, type FillTask } from "../api/fill-tasks.ts";
import { loadPersistedLlmConfig } from "../api/chat.ts";
import type { MemorySpace } from "../api/memory-spaces.ts";
import { Badge, Button, Field, TextInput } from "../ui.tsx";

interface FillTaskPanelProps {
  readonly space: MemorySpace;
}

/** 默认分块大小：与服务端 DEFAULT_FILL_TASK_BLOCK_SIZE 保持一致。 */
const DEFAULT_BLOCK_SIZE = 20;
/** 活动任务存在时轮询活动任务接口的间隔（完整状态轮询归 ticket 14）。 */
const ACTIVE_POLL_INTERVAL_MS = 2_000;

/**
 * 填表任务面板（ticket 13）：选择消息闭区间 [from, to] 与分块大小，
 * 提交后台填表任务；任务运行期间显示活动任务状态（空间只读由服务端强制）。
 * LLM 配置复用聊天面板的本地保存值；配置缺失时服务端返回明确错误。
 */
export function FillTaskPanel({ space }: FillTaskPanelProps) {
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(space.messageCount);
  const [blockSize, setBlockSize] = useState(DEFAULT_BLOCK_SIZE);
  const [active, setActive] = useState<FillTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [lastResult, setLastResult] = useState<string>();
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

  // 任务运行期间轻量轮询活动状态，结束后自动收起横幅（完整轮询归 14）。
  useEffect(() => {
    if (!active) return;
    pollTimer.current = setInterval(() => {
      void fetchActiveFillTask(space.id)
        .then((task) => setActive(task))
        .catch(() => undefined);
    }, ACTIVE_POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [active, space.id]);

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
      setLastResult(
        `任务已提交：${task.runId}（${task.from}–${task.to}，块大小 ${task.blockSize}）`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交任务失败");
    } finally {
      setBusy(false);
    }
  }

  const rangeInvalid = from < 1 || to < from || to > space.messageCount;
  const blocked = active !== null;

  return (
    <div className="fill-task-panel">
      <header className="tool-panel-heading">
        <div>
          <h3>后台填表任务</h3>
          <p>
            在「{space.name}」的消息区间内，由 Agent 批量提取结构化记忆写入各表格。
          </p>
        </div>
        <Badge tone="neutral">{space.messageCount} 条消息</Badge>
      </header>

      {active ? (
        <div className="fill-task-active">
          <LoaderCircle size={15} className="spinning" />
          <div>
            <strong>
              任务运行中
              {active.status === "succeeded" ? "（已完成）" : active.status === "failed" ? "（失败）" : ""}
            </strong>
            <span>
              {active.runId.slice(0, 8)} · 消息 {active.from}–{active.to} · 块大小{" "}
              {active.blockSize}
            </span>
          </div>
          <em>该空间任务期间只读</em>
        </div>
      ) : null}

      <form
        className="fill-task-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="fill-task-grid">
          <Field
            label="消息范围"
            hint={`共 ${space.messageCount} 条`}
            htmlFor="fill-from"
          >
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
          <Field
            label="分块大小"
            hint="每条消息单独写入"
            htmlFor="fill-block"
          >
            <TextInput
              id="fill-block"
              type="number"
              min={1}
              value={Number.isFinite(blockSize) ? blockSize : ""}
              onChange={(event) => setBlockSize(event.target.valueAsNumber)}
              aria-label="分块大小"
            />
          </Field>
          <Field label="提交任务" hint={blocked ? "已有任务运行中" : undefined} htmlFor="fill-submit">
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
      </div>
    </div>
  );
}
