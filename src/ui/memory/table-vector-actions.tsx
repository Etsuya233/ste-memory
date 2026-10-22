import { useEffect, useState } from "react";
import type { MemorySpaceId, MemoryTableId } from "../../features/memory/index.ts";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
import { reportError, reportSuccess } from "../shell/ui-helpers.tsx";

export function TableVectorActions(props: {
  readonly vector: VectorIndexService;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly enabled: boolean;
}) {
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const scope = { memorySpaceId: props.memorySpaceId, tableId: props.tableId };
  useEffect(() => {
    let cancelled = false;
    void Promise.all([props.vector.getTableSummary(scope), props.vector.getStatus(scope)])
      .then(([counts, state]) => {
        if (!cancelled)
          setSummary(
            `${counts.records} 条记录 · 就绪 ${counts.ready} · 待更新 ${counts.stale} · 异常 ${counts.errors} · 无内容 ${counts.empty} · 排队 ${counts.queued} · ${state.connection === "ready" ? "连接可用" : (state.error ?? "等待连接")}`,
          );
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
  return (
    <div className="stm-vector-table-actions" data-stm-section="table-vector-actions">
      <span className="stm-setting-hint">{props.enabled ? summary : "索引未启用"}</span>
      {props.enabled && <span className="stm-setting-hint">强制重算会产生额外的远端请求。</span>}
      {props.enabled && (
        <div className="stm-vector-task-buttons">
          <button
            type="button"
            className="stm-table-action"
            disabled={busy}
            onClick={() => void submit(false)}
          >
            补建索引
          </button>
          <button
            type="button"
            className="stm-table-action"
            disabled={busy}
            onClick={() => void submit(true)}
          >
            强制重算
          </button>
          <button
            type="button"
            className="stm-table-action stm-table-action--danger"
            disabled={busy}
            onClick={() => void clear()}
          >
            清除索引
          </button>
        </div>
      )}
    </div>
  );
}
