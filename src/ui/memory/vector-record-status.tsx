import { useEffect, useState } from "react";
import type { MemoryRecordId, MemorySpaceId, MemoryTableId } from "../../features/memory/index.ts";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
import type {
  RecordVector,
  VectorPreview,
  VectorTask,
  VectorTaskStatus,
} from "../../features/vector-index/types.ts";
import { reportError, reportSuccess } from "../shell/ui-helpers.tsx";

const taskLabels: Record<VectorTaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  obsolete: "已失效",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function VectorRecordStatus(props: {
  readonly vector: VectorIndexService;
  readonly memorySpaceId: MemorySpaceId;
  readonly tableId: MemoryTableId;
  readonly recordId: MemoryRecordId;
}) {
  const [previews, setPreviews] = useState<readonly VectorPreview[]>([]);
  const [tasks, setTasks] = useState<readonly VectorTask[]>([]);
  const [vectors, setVectors] = useState<readonly RecordVector[]>([]);
  const [connection, setConnection] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const scope = {
    memorySpaceId: props.memorySpaceId,
    tableId: props.tableId,
    recordId: props.recordId,
  };
  useEffect(() => {
    let cancelled = false;
    void Promise.all([props.vector.preview(scope), props.vector.getStatus(scope)])
      .then(([next, state]) => {
        if (!cancelled) {
          setPreviews(next);
          setTasks(state.tasks);
          setVectors(state.vectors);
          setConnection(state.error ?? (state.connection === "ready" ? "连接可用" : "等待连接"));
        }
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.vector, props.memorySpaceId, props.tableId, props.recordId, reload]);
  useEffect(() => {
    const timer = setInterval(() => setReload((value) => value + 1), 2000);
    return () => clearInterval(timer);
  }, []);

  async function submit(groupId?: string, force = false): Promise<void> {
    setBusy(true);
    try {
      const result = await props.vector.submit(scope, { source: "manual", groupId, force });
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

  const isReady = (item: VectorPreview) =>
    vectors.some(
      (vector) => vector.groupId === item.groupId && vector.fingerprint === item.fingerprint,
    );
  const ready = previews.filter(isReady).length;
  const empty = previews.filter((item) => item.status === "empty").length;
  const invalid = previews.filter(
    (item) =>
      item.status === "unavailable" ||
      item.status === "too_long" ||
      item.status === "configuration_invalid" ||
      tasks.some(
        (task) =>
          task.groupId === item.groupId &&
          task.fingerprint === item.fingerprint &&
          task.status === "failed" &&
          !isReady(item),
      ),
  ).length;
  return (
    <section className="stm-vector-record" data-stm-section="record-vector-status">
      <div className="stm-vector-group-head">
        <strong>向量索引</strong>
        <span>
          {previews.length
            ? `就绪 ${ready}/${previews.length}，无内容 ${empty}，异常 ${invalid}`
            : "暂无可用分组"}
        </span>
      </div>
      <p className="stm-setting-hint">{connection}</p>
      <p className="stm-setting-hint">
        强制重算会产生一次额外的远端 embedding 请求，已发出的请求可能仍产生费用。
      </p>
      <div className="stm-vector-task-buttons">
        <button
          type="button"
          className="stm-button"
          disabled={busy || previews.length === 0}
          onClick={() => void submit()}
        >
          向量化记录
        </button>
        <button
          type="button"
          className="stm-button"
          disabled={busy || previews.length === 0}
          onClick={() => void submit(undefined, true)}
        >
          强制重算记录
        </button>
      </div>
      {previews.map((preview) => {
        const cached = vectors.find(
          (vector) =>
            vector.groupId === preview.groupId && vector.fingerprint === preview.fingerprint,
        );
        const latest = tasks
          .filter((task) => task.groupId === preview.groupId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        return (
          <div className="stm-vector-preview-group" key={preview.groupId}>
            <div className="stm-vector-group-head">
              <strong>{preview.groupName}</strong>
              <span>
                {isReady(preview)
                  ? "已就绪"
                  : latest?.fingerprint === preview.fingerprint && latest.status === "running"
                    ? "处理中"
                    : latest?.fingerprint === preview.fingerprint && latest.status === "queued"
                      ? "排队中"
                      : preview.status === "configuration_invalid"
                        ? "配置失效"
                        : latest?.fingerprint === preview.fingerprint && latest.status === "failed"
                          ? "失败"
                          : preview.status === "empty"
                            ? "无内容"
                            : preview.status === "too_long"
                              ? "输入超限"
                              : preview.status === "unavailable"
                                ? "等待连接"
                                : vectors.some((vector) => vector.groupId === preview.groupId)
                                  ? "待更新"
                                  : "未生成"}
              </span>
            </div>
            {preview.error && <div className="stm-form-error">{preview.error}</div>}
            {cached && (
              <div className="stm-setting-hint">
                生成于 {cached.updatedAt} · 模型 {cached.model}
              </div>
            )}
            {latest && (
              <div className="stm-setting-hint">
                最近任务：{taskLabels[latest.status]} · 模型 {latest.model}
                {latest.error ? ` · ${latest.error}` : ""}
              </div>
            )}
            <pre>{preview.input || "（无内容）"}</pre>
            <div className="stm-vector-task-buttons">
              <button
                type="button"
                className="stm-table-action"
                disabled={busy || preview.status === "empty"}
                onClick={() => void submit(preview.groupId)}
              >
                生成 / 重试
              </button>
              <button
                type="button"
                className="stm-table-action"
                disabled={busy || preview.status === "empty"}
                onClick={() => void submit(preview.groupId, true)}
              >
                强制重算
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
