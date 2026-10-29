import { useEffect, useRef, useState } from "react";
import { ChevronRight, Copy, Filter, RefreshCw, Search, Trash2, X } from "lucide-react";
import {
  LOG_LIMIT,
  type LogEntry,
  type LogLevel,
  type LogRepository,
} from "../../../features/logging/log.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { Field, FieldLabel } from "../../../ui/primitives/field.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
} from "../../../ui/primitives/item.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/primitives/popover.tsx";
import { Skeleton } from "../../../ui/primitives/skeleton.tsx";
import { ConfirmAction } from "../../components/confirmation.tsx";
import {
  PageHeader,
  PageContent,
  PageFooter,
  type PageControls,
} from "../../components/page-layout.tsx";
import { PageEmpty, PageError } from "../../components/page-state.tsx";
import { PagePagination } from "../../components/page-pagination.tsx";
import { formatCompactTime } from "../../components/format-time.ts";
import { usePageScroll } from "../../components/use-page-scroll.ts";

const levelNames: Record<LogLevel, string> = { info: "信息", warn: "警告", error: "错误" };
const defaultPageSize = 30;

export function LogsPage({
  logs,
  controls,
  onBack,
  title = "日志",
  backLabel,
  context,
  initialKey = "",
}: {
  logs: Pick<LogRepository, "recent" | "byKey" | "clearAll">;
  controls: PageControls;
  onBack: () => void;
  title?: string;
  backLabel?: string;
  context?: string;
  initialKey?: string;
}) {
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [key, setKey] = useState(initialKey);
  const [keyInput, setKeyInput] = useState(initialKey);
  const [level, setLevel] = useState<LogLevel | "">("");
  const [type, setType] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [filterOpen, setFilterOpen] = useState(false);
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "error">("idle");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const request = useRef(0);
  const viewKey = selected
    ? `log-${selected.id}`
    : JSON.stringify([key, level, type, keyword, page, pageSize]);
  const scroll = usePageScroll(logs, viewKey, !loading, !selected);

  async function refresh() {
    const token = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const data = key ? await logs.byKey(key, LOG_LIMIT) : await logs.recent(LOG_LIMIT);
      if (token === request.current) setEntries(data);
    } catch (cause) {
      if (token === request.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [logs, key]);
  useEffect(() => {
    setCopied("idle");
  }, [selected?.id]);

  const filtered = entries.filter(
    (entry) =>
      (!level || entry.level === level) &&
      (!type || entry.type === type) &&
      (!keyword ||
        `${entry.text}\n${entry.key}`.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const filtering = Boolean(key || level || type || keyword);
  const related = selected?.key
    ? entries.filter((entry) => entry.key === selected.key && entry.id !== selected.id).slice(0, 6)
    : [];
  const typeOptions = [
    ...new Set([...entries.map((entry) => entry.type), ...(type ? [type] : [])]),
  ];

  function goToPage(target: number) {
    scroll.ref.current?.scrollTo({ top: 0 });
    setPage(Math.min(Math.max(target, 0), totalPages - 1));
  }
  function clearFilters() {
    setKey("");
    setKeyInput("");
    setLevel("");
    setType("");
    setKeyword("");
    setPage(0);
  }
  function openTaskLogs() {
    if (!selected?.key) return;
    setKeyInput(selected.key);
    setKey(selected.key);
    setSelected(null);
    setPage(0);
  }
  async function copySelected() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.text);
      setCopied("done");
    } catch {
      setCopied("error");
    }
  }

  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col ste:text-sm">
      <PageHeader
        title={selected ? "日志详情" : title}
        subtitle={
          selected ? `${selected.type} · ${levelNames[selected.level]}` : (context ?? "最近日志")
        }
        {...controls}
        busy={clearing}
        onBack={selected ? () => setSelected(null) : onBack}
        backLabel={selected ? "返回日志" : (backLabel ?? "返回")}
        actions={
          !selected ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                aria-label="刷新日志"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <RefreshCw />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="清空全部日志"
                disabled={loading || !entries.length}
                onClick={() => setConfirm(true)}
              >
                <Trash2 />
              </Button>
            </>
          ) : undefined
        }
      />
      <PageContent className="ste:flex ste:min-w-0 ste:flex-col ste:overflow-hidden">
        {selected ? (
          <div
            ref={scroll.ref}
            onScroll={scroll.onScroll}
            data-page-scroll="log-detail"
            className="ste:flex ste:min-h-0 ste:flex-1 ste:flex-col ste:gap-3 ste:overflow-y-auto ste:overscroll-contain"
          >
            <dl className="ste:grid ste:grid-cols-[auto_minmax(0,1fr)] ste:gap-x-3 ste:gap-y-1.5 ste:rounded-xl ste:border ste:border-border ste:p-3 ste:text-xs">
              <dt className="ste:text-muted-foreground">时间</dt>
              <dd className="ste:break-words">{new Date(selected.createdAt).toLocaleString()}</dd>
              <dt className="ste:text-muted-foreground">级别</dt>
              <dd>
                <Badge variant={selected.level === "error" ? "destructive" : "secondary"}>
                  {levelNames[selected.level]}
                </Badge>
              </dd>
              <dt className="ste:text-muted-foreground">类型</dt>
              <dd className="ste:break-all">{selected.type}</dd>
              <dt className="ste:text-muted-foreground">任务 Key</dt>
              <dd className="ste:break-all">{selected.key || "无"}</dd>
            </dl>
            <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
              <Button variant="outline" size="sm" onClick={() => void copySelected()}>
                <Copy data-icon="inline-start" />
                {copied === "done" ? "已复制" : "复制内容"}
              </Button>
              {selected.key ? (
                <Button variant="outline" size="sm" onClick={openTaskLogs}>
                  查看该任务全部日志
                </Button>
              ) : null}
              {copied === "error" ? (
                <span role="status" className="ste:text-xs ste:text-destructive">
                  复制失败，请手动选择日志内容。
                </span>
              ) : null}
            </div>
            <pre
              className="ste:max-h-[60vh] ste:overflow-auto ste:rounded-xl ste:bg-muted ste:p-3 ste:text-xs ste:whitespace-pre-wrap ste:break-words"
              data-testid="log-text"
            >
              {selected.text}
            </pre>
            {related.length > 0 && (
              <section className="ste:flex ste:flex-col ste:gap-2">
                <h2 className="ste:text-sm ste:font-semibold">同一任务的其它日志</h2>
                <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border ste:overflow-hidden ste:rounded-xl ste:border ste:border-border">
                  {related.map((entry) => (
                    <LogRow
                      key={entry.id}
                      entry={entry}
                      action="open-related-log"
                      onOpen={setSelected}
                    />
                  ))}
                </ItemGroup>
              </section>
            )}
          </div>
        ) : (
          <>
            {error ? (
              <div className="ste:shrink-0">
                <PageError error={error} onRetry={() => void refresh()} />
              </div>
            ) : null}
            <div className="ste:flex ste:shrink-0 ste:flex-col ste:gap-2 ste:pb-4">
              <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
                <div className="ste:relative ste:min-w-40 ste:flex-1">
                  <Search className="ste:pointer-events-none ste:absolute ste:top-1/2 ste:left-3 ste:size-4 ste:-translate-y-1/2 ste:text-muted-foreground" />
                  <Input
                    id="logs-keyword"
                    type="search"
                    aria-label="内容关键词"
                    className="ste:pl-9"
                    placeholder="搜索日志内容"
                    value={keyword}
                    onChange={(event) => {
                      setKeyword(event.target.value);
                      setPage(0);
                    }}
                  />
                </div>
                <NativeSelect
                  aria-label="级别"
                  className="ste:w-28"
                  value={level}
                  onChange={(event) => {
                    setLevel(event.target.value as LogLevel | "");
                    setPage(0);
                  }}
                >
                  <option value="">全部级别</option>
                  {Object.entries(levelNames).map(([value, name]) => (
                    <option key={value} value={value}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label="类型"
                  className="ste:w-32"
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">全部类型</option>
                  {typeOptions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </NativeSelect>
                <Popover open={filterOpen} onOpenChange={setFilterOpen}>
                  <PopoverTrigger
                    render={<Button variant="outline" size="sm" data-action="filter-task-key" />}
                    aria-label="任务 Key 筛选"
                  >
                    <Filter data-icon="inline-start" />
                    任务 Key
                    {key ? <Badge variant="secondary">已筛选</Badge> : null}
                  </PopoverTrigger>
                  <PopoverContent align="end" className="ste:w-80">
                    <form
                      className="ste:flex ste:flex-col ste:gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        setKey(keyInput.trim());
                        setPage(0);
                        setFilterOpen(false);
                      }}
                    >
                      <Field>
                        <FieldLabel htmlFor="logs-key">任务 Key</FieldLabel>
                        <Input
                          id="logs-key"
                          value={keyInput}
                          placeholder="完整任务 Key，留空查看全部"
                          onChange={(event) => setKeyInput(event.target.value)}
                        />
                      </Field>
                      <div className="ste:flex ste:justify-end ste:gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={!key && !keyInput}
                          onClick={() => {
                            setKey("");
                            setKeyInput("");
                            setPage(0);
                            setFilterOpen(false);
                          }}
                        >
                          清除
                        </Button>
                        <Button type="submit" size="sm">
                          查询
                        </Button>
                      </div>
                    </form>
                  </PopoverContent>
                </Popover>
              </div>
              <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2 ste:text-xs ste:text-muted-foreground">
                <span>
                  共 {filtered.length} 条 · 上限 {LOG_LIMIT} 条
                </span>
                {key ? (
                  <FilterChip
                    label={`任务 Key：${key}`}
                    onClear={() => {
                      setKey("");
                      setKeyInput("");
                      setPage(0);
                    }}
                  />
                ) : null}
                {level ? (
                  <FilterChip
                    label={`级别：${levelNames[level]}`}
                    onClear={() => {
                      setLevel("");
                      setPage(0);
                    }}
                  />
                ) : null}
                {type ? (
                  <FilterChip
                    label={`类型：${type}`}
                    onClear={() => {
                      setType("");
                      setPage(0);
                    }}
                  />
                ) : null}
                {filtering ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ste:h-7 ste:px-2 ste:text-xs"
                    onClick={clearFilters}
                  >
                    清除筛选
                  </Button>
                ) : null}
              </div>
            </div>
            <div
              ref={scroll.ref}
              onScroll={scroll.onScroll}
              data-page-scroll="logs"
              className="ste:flex ste:min-h-0 ste:flex-1 ste:flex-col ste:gap-3 ste:overflow-y-auto ste:overscroll-contain"
            >
              {loading ? (
                <div aria-label="正在加载日志" className="ste:flex ste:flex-col ste:gap-3">
                  {[0, 1, 2, 3].map((item) => (
                    <Skeleton key={item} className="ste:h-24 ste:w-full ste:rounded-2xl" />
                  ))}
                </div>
              ) : filtered.length ? (
                <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border ste:overflow-hidden ste:rounded-xl ste:border ste:border-border">
                  {filtered
                    .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                    .map((entry) => (
                      <LogRow key={entry.id} entry={entry} onOpen={setSelected} />
                    ))}
                </ItemGroup>
              ) : (
                <PageEmpty
                  title={filtering || entries.length ? "没有符合条件的日志" : "还没有日志"}
                  description={
                    filtering || entries.length
                      ? "调整筛选条件，或清除筛选查看全部日志。"
                      : "执行填表或索引任务后，运行记录会出现在这里。"
                  }
                >
                  <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-center ste:gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loading}
                      onClick={() => void refresh()}
                    >
                      刷新
                    </Button>
                    {filtering ? (
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        清除筛选
                      </Button>
                    ) : null}
                  </div>
                </PageEmpty>
              )}
            </div>
          </>
        )}
      </PageContent>
      {!selected ? (
        <PageFooter className="ste:px-3 ste:py-2">
          <PagePagination
            label="日志分页"
            page={currentPage + 1}
            totalPages={totalPages}
            total={filtered.length}
            pageSize={pageSize}
            pageSizeOptions={[10, 20, 30, 50, 100]}
            disabled={loading}
            onPageChange={(next) => goToPage(next - 1)}
            onPageSizeChange={(size) => {
              scroll.ref.current?.scrollTo({ top: 0 });
              setPage(0);
              setPageSize(size);
            }}
          />
        </PageFooter>
      ) : null}
      <ConfirmAction
        open={confirm}
        onOpenChange={setConfirm}
        title="清空全部日志？"
        description="将删除本机保存的全部类型和任务日志。记忆记录与任务队列保留，日志无法恢复。"
        confirmLabel="确认清空日志"
        destructive
        onConfirm={async () => {
          setClearing(true);
          request.current++;
          try {
            await logs.clearAll();
            setEntries([]);
            setSelected(null);
            setPage(0);
            setError(null);
            setLoading(false);
          } finally {
            setClearing(false);
          }
        }}
      />
    </div>
  );
}

function LogRow({
  entry,
  action = "open-log",
  onOpen,
}: {
  entry: LogEntry;
  action?: "open-log" | "open-related-log";
  onOpen: (entry: LogEntry) => void;
}) {
  return (
    <div role="listitem">
      <Item
        render={<button type="button" />}
        className="ste:cursor-pointer ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
        data-action={action}
        data-log-id={entry.id}
        data-log-key={entry.key}
        data-log-level={entry.level}
        data-log-type={entry.type}
        onClick={() => onOpen(entry)}
      >
        <ItemContent>
          <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
            <Badge variant={entry.level === "error" ? "destructive" : "secondary"}>
              {levelNames[entry.level]}
            </Badge>
            <span className="ste:break-all ste:text-sm ste:font-medium">{entry.type}</span>
            <span className="ste:ml-auto ste:text-xs ste:text-muted-foreground">
              {formatCompactTime(entry.createdAt)}
            </span>
          </div>
          <ItemDescription className="ste:line-clamp-2 ste:break-all">{entry.text}</ItemDescription>
          {entry.key ? (
            <p className="ste:line-clamp-1 ste:break-all ste:text-xs ste:text-muted-foreground">
              Key {entry.key}
            </p>
          ) : null}
        </ItemContent>
        <ItemActions>
          <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
        </ItemActions>
      </Item>
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <Badge variant="secondary" className="ste:gap-1 ste:pr-1" title={label}>
      <span className="ste:max-w-40 ste:truncate">{label}</span>
      <button
        type="button"
        aria-label={`清除${label}筛选`}
        className="ste:rounded-full ste:p-0.5 ste:hover:bg-background/60 ste:focus-visible:ring-2 ste:focus-visible:ring-ring/50 ste:focus-visible:outline-none"
        onClick={onClear}
      >
        <X className="ste:size-3" />
      </button>
    </Badge>
  );
}
