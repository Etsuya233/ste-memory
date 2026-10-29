import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Trash2 } from "lucide-react";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../../ui/primitives/accordion.tsx";
import { ConfirmAction } from "../../components/confirmation.tsx";
import {
  PageHeader,
  PageContent,
  PageFooter,
  type PageControls,
} from "../../components/page-layout.tsx";
import { PageEmpty, PageError } from "../../components/page-state.tsx";
import { usePageScroll } from "../../components/use-page-scroll.ts";

const levelNames: Record<LogLevel, string> = { info: "信息", warn: "警告", error: "错误" };
const pageSize = 30;
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
  const [selected, setSelected] = useState<LogEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const request = useRef(0);
  const viewKey = selected
    ? `log-${selected.id}`
    : JSON.stringify([key, level, type, keyword, page]);
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
  const filtered = entries.filter(
    (entry) =>
      (!level || entry.level === level) &&
      (!type || entry.type === type) &&
      (!keyword ||
        `${entry.text}\n${entry.key}`.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())),
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const related = selected?.key
    ? entries.filter((entry) => entry.key === selected.key && entry.id !== selected.id).slice(0, 6)
    : [];
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title={selected ? "日志详情" : title}
        subtitle={
          selected
            ? `${selected.type} · ${levelNames[selected.level]}`
            : (context ?? "最近日志 · 手动刷新")
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
      <PageContent
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        className="ste:flex ste:flex-col ste:gap-3 ste:[&>*]:shrink-0"
        data-page-scroll="logs"
      >
        {error && <PageError error={error} onRetry={() => void refresh()} />}
        {selected ? (
          <>
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
                    <div role="listitem" key={entry.id}>
                      <Item
                        render={<button type="button" />}
                        className="ste:cursor-pointer ste:rounded-none ste:border-0 ste:px-4 ste:py-2 ste:text-left ste:hover:bg-muted/60"
                        data-action="open-related-log"
                        data-log-id={entry.id}
                        onClick={() => setSelected(entry)}
                      >
                        <ItemContent>
                          <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
                            <Badge variant={entry.level === "error" ? "destructive" : "secondary"}>
                              {levelNames[entry.level]}
                            </Badge>
                            <span className="ste:text-sm ste:font-medium">{entry.type}</span>
                            <span className="ste:ml-auto ste:text-xs ste:text-muted-foreground">
                              {new Date(entry.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="ste:line-clamp-1 ste:break-all ste:text-xs ste:text-muted-foreground">
                            {entry.text}
                          </p>
                        </ItemContent>
                        <ItemActions>
                          <ChevronRight className="ste:size-4" />
                        </ItemActions>
                      </Item>
                    </div>
                  ))}
                </ItemGroup>
              </section>
            )}
          </>
        ) : (
          <>
            <form
              className="ste:flex ste:items-end ste:gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setKey(keyInput.trim());
                setPage(0);
              }}
            >
              <Field className="ste:min-w-0 ste:flex-1">
                <FieldLabel htmlFor="logs-key">任务 Key</FieldLabel>
                <Input
                  id="logs-key"
                  value={keyInput}
                  placeholder="完整任务 Key，留空查看全部"
                  onChange={(event) => setKeyInput(event.target.value)}
                />
              </Field>
              <Button type="submit" disabled={loading}>
                查询
              </Button>
              {key && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={loading}
                  onClick={() => {
                    setKeyInput("");
                    setKey("");
                    setPage(0);
                  }}
                >
                  清除筛选
                </Button>
              )}
            </form>
            <Accordion>
              <AccordionItem value="filters">
                <AccordionTrigger>筛选</AccordionTrigger>
                <AccordionContent>
                  <div className="ste:flex ste:flex-col ste:gap-3">
                    <div className="ste:grid ste:gap-3 ste:sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="logs-level">级别</FieldLabel>
                        <NativeSelect
                          id="logs-level"
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
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="logs-type">类型</FieldLabel>
                        <NativeSelect
                          id="logs-type"
                          value={type}
                          onChange={(event) => {
                            setType(event.target.value);
                            setPage(0);
                          }}
                        >
                          <option value="">全部类型</option>
                          {[
                            ...new Set([
                              ...entries.map((entry) => entry.type),
                              ...(type ? [type] : []),
                            ]),
                          ].map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                        </NativeSelect>
                      </Field>
                    </div>
                    <Field>
                      <FieldLabel htmlFor="logs-keyword">内容关键词</FieldLabel>
                      <Input
                        id="logs-keyword"
                        value={keyword}
                        onChange={(event) => {
                          setKeyword(event.target.value);
                          setPage(0);
                        }}
                      />
                    </Field>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            <p className="ste:text-xs ste:text-muted-foreground">
              读取最近 {entries.length} 条，上限 {LOG_LIMIT} 条；筛选后 {filtered.length} 条。
              日志独立存储，不随记忆备份导出。
            </p>
            {loading ? (
              <p role="status">正在读取日志…</p>
            ) : filtered.length ? (
              <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border ste:overflow-hidden ste:rounded-xl ste:border ste:border-border">
                {filtered
                  .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                  .map((entry) => (
                    <div role="listitem" key={entry.id}>
                      <Item
                        render={<button type="button" />}
                        className="ste:cursor-pointer ste:rounded-none ste:border-0 ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                        data-action="open-log"
                        data-log-key={entry.key}
                        data-log-level={entry.level}
                        data-log-type={entry.type}
                        onClick={() => setSelected(entry)}
                      >
                        <ItemContent>
                          <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
                            <Badge variant={entry.level === "error" ? "destructive" : "secondary"}>
                              {levelNames[entry.level]}
                            </Badge>
                            <span className="ste:break-all ste:text-sm ste:font-medium">
                              {entry.type}
                            </span>
                            <span className="ste:ml-auto ste:text-xs ste:text-muted-foreground">
                              {new Date(entry.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <ItemDescription className="ste:line-clamp-2 ste:break-all">
                            {entry.text}
                          </ItemDescription>
                          {entry.key && (
                            <p className="ste:break-all ste:text-xs ste:text-muted-foreground">
                              Key: {entry.key}
                            </p>
                          )}
                        </ItemContent>
                        <ItemActions>
                          <ChevronRight className="ste:size-4" />
                        </ItemActions>
                      </Item>
                    </div>
                  ))}
              </ItemGroup>
            ) : (
              <PageEmpty
                title="没有符合条件的日志"
                description="调整筛选，或执行任务后手动刷新。"
              />
            )}
          </>
        )}
      </PageContent>
      {!selected && totalPages > 1 && (
        <PageFooter>
          <Button
            variant="outline"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </Button>
          <span className="ste:text-xs">
            {currentPage + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            disabled={currentPage + 1 === totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </Button>
        </PageFooter>
      )}
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
