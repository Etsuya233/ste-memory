import { useEffect, useState } from "react";
import type { MemorySpaceId, MemoryTableId } from "../../features/memory/index.ts";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
import type { VectorTableSummary } from "../../features/vector-index/types.ts";
import { reportError, reportSuccess } from "../shell/ui-helpers.tsx";

/** 已保存配置下的索引现状与维护动作；只在展开“索引维护”时挂载。 */
export function TableVectorActions(props: {
  readonly vector: VectorIndexService;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly enabled: boolean;
}) {
  const [counts, setCounts] = useState<VectorTableSummary | null>(null);
  const [connection, setConnection] = useState<{
    readonly state: "ready" | "missing" | "blocked";
    readonly error: string | null;
  }>({ state: "ready", error: null });
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const scope = { memorySpaceId: props.memorySpaceId, tableId: props.tableId };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([props.vector.getTableSummary(scope), props.vector.getStatus(scope)])
      .then(([next, state]) => {
        if (cancelled) return;
        setCounts(next);
        setConnection({ state: state.connection, error: state.error });
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.vector, props.memorySpaceId, props.tableId, reload]);

  useEffect(() => {
    const timer = setInterval(() => setReload((value) => value + 1), 3000);
    return () => clearInterval(timer);
  }, []);

  async function submit(force: boolean): Promise<void> {
    setBusy(true);
    try {
      const result = await props.vector.submit(scope, { source: "manual", force });
      reportSuccess(
        `向量任务：新建 ${result.created}、复用 ${result.reused}、提升 ${result.promoted}、跳过 ${result.skipped}`,
      );
      setReload((value) => value + 1);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    if (
      !window.confirm(
        "清除这张表的向量索引？记忆记录会保留。自动补建将在用户重新触发或目标变化后继续。",
      )
    )
      return;
    setBusy(true);
    try {
      await props.vector.clear(scope);
      reportSuccess("向量索引已清除");
      setReload((value) => value + 1);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  if (!props.enabled) {
    return (
      <div className="stm-vector-maintenance" data-stm-section="table-vector-actions">
        <p className="stm-vector-empty">索引未启用</p>
      </div>
    );
  }

  const connectionLabel =
    connection.state === "ready"
      ? "连接可用"
      : connection.state === "blocked"
        ? "连接受阻"
        : "未连接";

  return (
    <div className="stm-vector-maintenance" data-stm-section="table-vector-actions">
      <div className="stm-vector-maintenance-head">
        <span className="stm-vector-maintenance-scope">当前索引</span>
        <span
          className="stm-vector-connection"
          data-state={connection.state}
          title={connection.error ?? undefined}
        >
          {connectionLabel}
        </span>
      </div>
      <div className="stm-vector-maintenance-state">
        <span>
          <i className="stm-vector-dot" data-tone="success" aria-hidden="true" />
          已就绪 {counts?.ready ?? "—"}
        </span>
        <span data-muted={counts?.stale === 0 ? "true" : undefined}>
          <i className="stm-vector-dot" data-tone="accent" aria-hidden="true" />
          待更新 {counts?.stale ?? "—"}
        </span>
        {counts && counts.errors > 0 ? (
          <span>
            <i className="stm-vector-dot" data-tone="danger" aria-hidden="true" />
            异常 {counts.errors}
          </span>
        ) : null}
        {counts && counts.queued > 0 ? (
          <span>
            <i className="stm-vector-dot" data-tone="warning" aria-hidden="true" />
            排队 {counts.queued}
          </span>
        ) : null}
      </div>
      <div className="stm-vector-maintenance-actions">
        <button
          type="button"
          className="stm-button"
          aria-label="补建缺失或过期的索引"
          disabled={busy}
          onClick={() => void submit(false)}
        >
          补建
        </button>
        <button
          type="button"
          className="stm-button"
          aria-label="强制重算全部索引"
          disabled={busy}
          onClick={() => void submit(true)}
        >
          重算
        </button>
        <button
          type="button"
          className="stm-button stm-button--danger"
          aria-label="清除这张表的索引"
          disabled={busy}
          onClick={() => void clear()}
        >
          清除
        </button>
      </div>
    </div>
  );
}
