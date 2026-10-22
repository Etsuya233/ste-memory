import { useEffect, useState } from "react";
import type { VectorIndexService } from "../../features/vector-index/vector-index-service.ts";
import type {
  VectorTask,
  VectorTaskFilters,
  VectorTaskPage,
  VectorTaskStatus,
} from "../../features/vector-index/types.ts";
import type {
  MemorySpaceId,
  MemoryTableId,
  MemorySpaceService,
  MemoryTableService,
} from "../../features/memory/index.ts";
import { reportError, reportSuccess } from "../shell/ui-helpers.tsx";

const PAGE_SIZE = 30;
const statusLabels: Record<VectorTaskStatus, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  obsolete: "已失效",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function VectorTasks(props: {
  readonly vector: VectorIndexService;
  readonly spaces: Pick<MemorySpaceService, "list">;
  readonly tables: Pick<MemoryTableService, "list">;
  readonly currentSpaceId?: MemorySpaceId;
}) {
  const [spaceFilter, setSpaceFilter] = useState("current");
  const [tableId, setTableId] = useState("");
  const [status, setStatus] = useState("active");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<VectorTaskPage | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detail, setDetail] = useState<VectorTask | null>(null);
  const [reload, setReload] = useState(0);
  const [allTasks, setAllTasks] = useState<readonly VectorTask[]>([]);
  const [spaceNames, setSpaceNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [tableNames, setTableNames] = useState<ReadonlyMap<string, string>>(new Map());
  const effectiveSpace =
    spaceFilter === "current"
      ? props.currentSpaceId
      : spaceFilter === "all"
        ? undefined
        : (spaceFilter as MemorySpaceId);

  useEffect(() => {
    setTableId("");
    setPage(0);
    setSelected(new Set());
    setDetail(null);
    setResult(null);
  }, [effectiveSpace]);

  useEffect(() => {
    let cancelled = false;
    const filter: VectorTaskFilters = {
      memorySpaceId: effectiveSpace,
      tableId: tableId ? (tableId as MemoryTableId) : undefined,
      statuses:
        status === "active"
          ? ["queued", "running"]
          : status
            ? [status as VectorTaskStatus]
            : undefined,
      source: source === "manual" || source === "automatic" ? source : undefined,
      search: search.trim() || undefined,
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    };
    void Promise.all([props.vector.listTasks(filter), props.vector.listTasks({ limit: 10000 })])
      .then(([filtered, all]) => {
        if (!cancelled) {
          setResult(filtered);
          setAllTasks(all.items);
        }
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.vector, effectiveSpace, tableId, status, source, search, page, reload]);

  useEffect(() => {
    let cancelled = false;
    void props.spaces
      .list()
      .then(async (spaces) => {
        const tableLists = await Promise.all(spaces.map((space) => props.tables.list(space.id)));
        if (cancelled) return;
        setSpaceNames(new Map(spaces.map((space) => [space.id, space.name])));
        setTableNames(
          new Map(
            tableLists.flatMap((tables) => tables.map((table) => [table.id, table.name] as const)),
          ),
        );
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.spaces, props.tables, reload]);

  useEffect(() => {
    const timer = setInterval(() => setReload((value) => value + 1), 2000);
    return () => clearInterval(timer);
  }, []);

  const spaces = [...new Set(allTasks.map((task) => task.memorySpaceId))];
  const tableOptions = [
    ...new Map(
      allTasks
        .filter((task) => !effectiveSpace || task.memorySpaceId === effectiveSpace)
        .map((task) => [task.tableId, task.tableId]),
    ).values(),
  ];
  const cancellable = (task: VectorTask) => task.status === "queued" || task.status === "running";
  async function act(action: () => Promise<unknown>, success: string): Promise<void> {
    try {
      await action();
      reportSuccess(success);
      setReload((value) => value + 1);
    } catch (error) {
      reportError(error);
    }
  }
  function reset(): void {
    setSpaceFilter("current");
    setTableId("");
    setStatus("active");
    setSource("");
    setSearch("");
    setPage(0);
    setSelected(new Set());
  }

  return (
    <section className="stm-task-card stm-vector-tasks" data-stm-section="vector-tasks">
      <div className="stm-task-card-title">向量任务</div>
      <p className="stm-setting-hint">
        每条记录的每个分组对应一项任务。请求依次按当前手动、后台手动、当前自动、后台自动处理；已发出的请求完成后重新排序。
      </p>
      <div className="stm-vector-task-counts">
        全局未结束 {result ? result.queued + result.running : 0} · 运行中 {result?.running ?? 0} ·
        阻塞 {result?.blocked ?? 0} · 当前筛选 {result?.total ?? 0}
      </div>
      <div className="stm-vector-filters">
        <label>
          空间{" "}
          <select
            className="stm-input"
            value={spaceFilter}
            onChange={(event) => {
              setSpaceFilter(event.target.value);
            }}
          >
            <option value="current">当前空间</option>
            <option value="all">全部空间</option>
            {spaces.map((id) => (
              <option key={id} value={id}>
                {spaceNames.get(id) ?? id}
              </option>
            ))}
          </select>
        </label>
        <label>
          表格{" "}
          <select
            className="stm-input"
            value={tableId}
            onChange={(event) => {
              setTableId(event.target.value);
              setPage(0);
            }}
          >
            <option value="">全部表格</option>
            {tableOptions.map((id) => (
              <option key={id} value={id}>
                {tableNames.get(id) ?? id}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态{" "}
          <select
            className="stm-input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(0);
            }}
          >
            <option value="active">未结束</option>
            <option value="">全部状态</option>
            {Object.entries(statusLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          来源{" "}
          <select
            className="stm-input"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(0);
            }}
          >
            <option value="">全部来源</option>
            <option value="manual">手动</option>
            <option value="automatic">自动</option>
          </select>
        </label>
        <label>
          记录 / 分组{" "}
          <input
            type="search"
            className="stm-input"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <button type="button" className="stm-button" onClick={reset}>
          清除筛选
        </button>
      </div>
      <div className="stm-vector-task-actions">
        <button
          type="button"
          className="stm-button stm-button--danger"
          disabled={selected.size === 0}
          onClick={() =>
            void act(async () => {
              await props.vector.cancelMany([...selected]);
              setSelected(new Set());
            }, `已取消选中的 ${selected.size} 项向量任务`)
          }
        >
          取消已选 {selected.size} 项
        </button>
      </div>
      {result?.items.length === 0 && <div className="stm-empty-hint">当前筛选没有向量任务</div>}
      <ul className="stm-vector-task-list">
        {result?.items.map((task) => (
          <li className="stm-vector-task" key={task.id}>
            <input
              type="checkbox"
              aria-label={`选择任务 ${task.groupName}`}
              disabled={!cancellable(task)}
              checked={selected.has(task.id)}
              onChange={(event) =>
                setSelected((old) => {
                  const next = new Set(old);
                  if (event.target.checked) next.add(task.id);
                  else next.delete(task.id);
                  return next;
                })
              }
            />
            <div className="stm-vector-task-main">
              <strong>
                {task.recordDisplayText} · {task.groupName}
              </strong>
              <div>
                <span title={`${task.memorySpaceId} / ${task.tableId}`}>
                  {spaceNames.get(task.memorySpaceId) ?? task.memorySpaceId} /{" "}
                  {tableNames.get(task.tableId) ?? task.tableId}
                </span>{" "}
                · {task.source === "manual" ? "手动" : "自动"}
                {task.force ? " · 强制重算" : ""} · {statusLabels[task.status]}
              </div>
              {task.waitReason && <div className="stm-setting-hint">等待：{task.waitReason}</div>}
              {task.error && <div className="stm-form-error">{task.error}</div>}
              <div className="stm-setting-hint">
                创建 {task.createdAt}
                {task.startedAt ? ` · 开始 ${task.startedAt}` : ""}
                {task.endedAt ? ` · 结束 ${task.endedAt}` : ""}
              </div>
            </div>
            <div className="stm-vector-task-buttons">
              <button type="button" className="stm-table-action" onClick={() => setDetail(task)}>
                详情
              </button>
              {cancellable(task) && (
                <button
                  type="button"
                  className="stm-table-action stm-table-action--danger"
                  onClick={() => void act(() => props.vector.cancel(task.id), "任务已取消")}
                >
                  取消
                </button>
              )}
              {["failed", "cancelled", "interrupted", "obsolete"].includes(task.status) && (
                <button
                  type="button"
                  className="stm-table-action"
                  onClick={() => void act(() => props.vector.retry(task.id), "已提交重试")}
                >
                  重试
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="stm-pagination">
        <button
          type="button"
          className="stm-page-button"
          disabled={page === 0}
          onClick={() => setPage(page - 1)}
        >
          上一页
        </button>
        <span className="stm-pagination-info">
          {result?.total ? page + 1 : 0} / {Math.ceil((result?.total ?? 0) / PAGE_SIZE)}
        </span>
        <button
          type="button"
          className="stm-page-button"
          disabled={(page + 1) * PAGE_SIZE >= (result?.total ?? 0)}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </div>
      {detail && (
        <div className="stm-vector-task-detail">
          <div className="stm-vector-group-head">
            <strong>向量任务详情</strong>
            <button type="button" className="stm-table-action" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
          <p>
            模型 {detail.model} · 版本 {detail.version} · 目标 {detail.fingerprint}
          </p>
          <pre>{detail.input}</pre>
        </div>
      )}
    </section>
  );
}
