import { useEffect, useRef, useState } from "react";
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

import { Disclosure } from "../shell/disclosure.tsx";
import { PageChrome } from "../shell/page-layout.tsx";
import { PanelBar, PanelBarAction, PanelBottomBar } from "../shell/panel-bar.tsx";

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
  readonly active?: boolean;
  readonly vector: VectorIndexService;
  readonly spaces: Pick<MemorySpaceService, "list">;
  readonly tables: Pick<MemoryTableService, "list">;
  readonly currentSpaceId?: MemorySpaceId;
}) {
  const viewRef = useRef<HTMLElement>(null);
  const listScrollTop = useRef(0);
  const wasShowingDetail = useRef(false);
  const actionRunning = useRef(false);
  const requestRef = useRef(0);
  const [pending, setPending] = useState(false);
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
    listScrollTop.current = 0;
    wasShowingDetail.current = false;
    setTableId("");
    setPage(0);
    setSelected(new Set());
    setDetail(null);
    setResult(null);
  }, [effectiveSpace]);

  useEffect(() => {
    setSelected(new Set());
    setResult(null);
    const body = viewRef.current?.closest(".stm-panel-body");
    if (props.active !== false && body) body.scrollTop = 0;
  }, [effectiveSpace, tableId, status, source, search, page]);

  useEffect(() => {
    if (props.active === false || actionRunning.current) return;
    const request = ++requestRef.current;
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
        if (!cancelled && request === requestRef.current) {
          const lastPage = Math.max(0, Math.ceil(filtered.total / PAGE_SIZE) - 1);
          if (page > lastPage) setPage(lastPage);
          setResult(filtered);
          setAllTasks(all.items);
          setPending(false);
          setSelected(
            (old) =>
              new Set(
                [...old].filter((id) =>
                  filtered.items.some(
                    (task) =>
                      task.id === id && (task.status === "queued" || task.status === "running"),
                  ),
                ),
              ),
          );
          setDetail((old) => (old ? (all.items.find((task) => task.id === old.id) ?? old) : null));
        }
      })
      .catch((error) => {
        if (!cancelled && request === requestRef.current) {
          reportError(error);
          setPending(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.vector, effectiveSpace, tableId, status, source, search, page, reload, props.active]);

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
    if (props.active === false) return;
    const timer = setInterval(() => setReload((value) => value + 1), 2000);
    return () => clearInterval(timer);
  }, [props.active]);

  const showingDetail = detail !== null;
  useEffect(() => {
    if (props.active === false) return;
    const body = viewRef.current?.closest(".stm-panel-body");
    if (!body) return;
    const returning = wasShowingDetail.current && !showingDetail;
    wasShowingDetail.current = showingDetail;
    const frame = requestAnimationFrame(() => {
      body.scrollTop = returning ? listScrollTop.current : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [showingDetail, props.active]);

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
    actionRunning.current = true;
    requestRef.current += 1;
    setPending(true);
    try {
      await action();
      reportSuccess(success);
      actionRunning.current = false;
      setReload((value) => value + 1);
    } catch (error) {
      reportError(error);
      actionRunning.current = false;
      setPending(false);
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
    <section
      ref={viewRef}
      className="stm-task-tab stm-vector-tasks"
      data-stm-section="vector-tasks"
    >
      {props.active !== false ? (
        <PageChrome
          header={
            detail ? (
              <PanelBar
                title="向量任务"
                subtitle={statusLabels[detail.status]}
                leading={
                  <PanelBarAction
                    icon="fa-arrow-left"
                    label="返回任务列表"
                    data-action="vector-detail-back"
                    onClick={() => setDetail(null)}
                  />
                }
              />
            ) : undefined
          }
          headerTrailing={
            !detail ? (
              <PanelBarAction
                icon="fa-rotate"
                label="刷新向量任务"
                data-action="refresh-vector-tasks"
                disabled={pending}
                onClick={() => setReload((value) => value + 1)}
              />
            ) : undefined
          }
          footer={
            !detail ? (
              <PanelBottomBar
                label="向量任务分页"
                trailing={
                  selected.size > 0 ? (
                    <PanelBarAction
                      icon="fa-ban"
                      label={`取消已选 ${selected.size} 项`}
                      danger
                      data-action="cancel-selected-vector-tasks"
                      disabled={pending}
                      onClick={() =>
                        void act(async () => {
                          await props.vector.cancelMany([...selected]);
                          setSelected(new Set());
                        }, `已取消选中的 ${selected.size} 项向量任务`)
                      }
                    />
                  ) : undefined
                }
              >
                <PanelBarAction
                  icon="fa-chevron-left"
                  label="上一页"
                  data-action="vector-page-prev"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                />
                <span className="stm-pagination-info" aria-live="polite">
                  {result?.total ? page + 1 : 0} / {Math.ceil((result?.total ?? 0) / PAGE_SIZE)}
                </span>
                <PanelBarAction
                  icon="fa-chevron-right"
                  label="下一页"
                  data-action="vector-page-next"
                  disabled={(page + 1) * PAGE_SIZE >= (result?.total ?? 0)}
                  onClick={() => setPage(page + 1)}
                />
              </PanelBottomBar>
            ) : undefined
          }
        />
      ) : null}
      {detail ? (
        <article
          className="stm-vector-task-detail stm-grouped-list"
          data-stm-section="vector-task-detail"
        >
          <div className="stm-task-card-title">
            {detail.recordDisplayText} · {detail.groupName}
          </div>
          <div className="stm-task-hint">
            {spaceNames.get(detail.memorySpaceId) ?? detail.memorySpaceId} /{" "}
            {tableNames.get(detail.tableId) ?? detail.tableId} ·{" "}
            {detail.source === "manual" ? "手动" : "自动"}
            {detail.force ? " · 强制重算" : ""}
          </div>
          {detail.waitReason ? (
            <div className="stm-task-hint">等待：{detail.waitReason}</div>
          ) : null}
          {detail.error ? (
            <div className="stm-task-error" role="alert">
              {detail.error}
            </div>
          ) : null}
          <dl className="stm-vector-detail-fields">
            <dt>创建</dt>
            <dd>{detail.createdAt}</dd>
            {detail.startedAt ? (
              <>
                <dt>开始</dt>
                <dd>{detail.startedAt}</dd>
              </>
            ) : null}
            {detail.endedAt ? (
              <>
                <dt>结束</dt>
                <dd>{detail.endedAt}</dd>
              </>
            ) : null}
            <dt>模型</dt>
            <dd>{detail.model}</dd>
            <dt>版本</dt>
            <dd>{detail.version}</dd>
            <dt>目标</dt>
            <dd>{detail.fingerprint}</dd>
          </dl>
          <Disclosure icon="fa-align-left" title="输入原文">
            <pre>{detail.input}</pre>
          </Disclosure>
        </article>
      ) : (
        <>
          <div className="stm-vector-task-counts" aria-live="polite">
            全局未结束 {result ? result.queued + result.running : 0} · 运行中 {result?.running ?? 0}{" "}
            · 阻塞 {result?.blocked ?? 0}
          </div>
          <div className="stm-vector-task-toolbar">
            <label className="stm-task-field">
              <select
                className="stm-select"
                aria-label="任务状态"
                data-action="filter-vector-status"
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
            <span className="stm-task-hint">
              {result?.total ?? 0} 项{selected.size ? ` · 已选 ${selected.size}` : ""}
            </span>
          </div>
          <Disclosure
            icon="fa-filter"
            title="筛选任务"
            meta={spaceFilter !== "current" || tableId || source || search ? "已筛选" : "当前空间"}
          >
            <div className="stm-vector-filters">
              <label>
                空间{" "}
                <select
                  className="stm-input"
                  data-action="filter-vector-space"
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
                  data-action="filter-vector-table"
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
                来源{" "}
                <select
                  className="stm-input"
                  data-action="filter-vector-source"
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
                  data-action="filter-vector-search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(0);
                  }}
                />
              </label>
              <button
                type="button"
                className="stm-button"
                data-action="reset-vector-filters"
                onClick={reset}
              >
                清除筛选
              </button>
            </div>
          </Disclosure>
          {result?.items.length === 0 ? (
            <div className="stm-empty-hint">当前筛选没有向量任务</div>
          ) : null}
          {!result ? <div className="stm-empty-hint">正在加载任务…</div> : null}
          {result && result.items.length > 0 ? (
            <ul className="stm-vector-task-list stm-grouped-list">
              {result.items.map((task) => (
                <li className="stm-vector-task" key={task.id}>
                  <label className="stm-vector-task-select">
                    <input
                      type="checkbox"
                      aria-label={`选择任务 ${task.groupName}`}
                      disabled={pending || !cancellable(task)}
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
                  </label>
                  <button
                    type="button"
                    className="stm-vector-task-main"
                    data-action="vector-task-detail"
                    onClick={() => {
                      listScrollTop.current =
                        viewRef.current!.closest(".stm-panel-body")!.scrollTop;
                      setDetail(task);
                    }}
                  >
                    <span className="stm-vector-task-title">
                      {task.recordDisplayText} · {task.groupName}
                    </span>
                    <span className="stm-vector-task-summary">
                      {tableNames.get(task.tableId) ?? task.tableId} ·{" "}
                      {task.source === "manual" ? "手动" : "自动"}
                      {task.force ? " · 强制重算" : ""} · {statusLabels[task.status]}
                    </span>
                    {task.waitReason ? (
                      <span className="stm-task-hint">等待：{task.waitReason}</span>
                    ) : null}
                    {task.error ? <span className="stm-task-error">{task.error}</span> : null}
                  </button>
                  <div className="stm-vector-task-buttons stm-bar-group">
                    {cancellable(task) ? (
                      <PanelBarAction
                        icon="fa-stop"
                        label={`取消 ${task.groupName}`}
                        danger
                        disabled={pending}
                        data-action="cancel-vector-task"
                        onClick={() => void act(() => props.vector.cancel(task.id), "任务已取消")}
                      />
                    ) : null}
                    {["failed", "cancelled", "interrupted", "obsolete"].includes(task.status) ? (
                      <PanelBarAction
                        icon="fa-rotate-right"
                        label={`重试 ${task.groupName}`}
                        disabled={pending}
                        data-action="retry-vector-task"
                        onClick={() => void act(() => props.vector.retry(task.id), "已提交重试")}
                      />
                    ) : null}
                    {!cancellable(task) &&
                    !["failed", "cancelled", "interrupted", "obsolete"].includes(task.status) ? (
                      <i
                        className="fa-solid fa-chevron-right stm-task-chevron"
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <Disclosure icon="fa-circle-info" title="队列说明">
            <p className="stm-task-hint">
              每条记录的每个分组对应一项任务。依次处理当前手动、后台手动、当前自动、后台自动任务；每次请求完成后重新排序。
            </p>
          </Disclosure>
        </>
      )}
    </section>
  );
}
