import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { ArrowUpRight, Database, Search } from "lucide-react";
import type { MemoryRecordId, MemoryTableId } from "../../../features/memory/index.ts";
import type { EmbeddingConnection } from "../../../features/settings/embedding-connection.ts";
import type {
  RetrievalHit,
  RetrievalRange,
  RetrievalSelection,
  RetrievalState,
  VectorRetrievalService,
} from "../../../features/vector-retrieval/vector-retrieval-service.ts";
import { recordFieldValueText } from "../../../ui/memory/record-form-model.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { Checkbox } from "../../../ui/primitives/checkbox.tsx";
import { Skeleton } from "../../../ui/primitives/skeleton.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "../../../ui/primitives/accordion.tsx";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "../../../ui/primitives/card.tsx";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldGroup,
  FieldSet,
  FieldLegend,
} from "../../../ui/primitives/field.tsx";
import { PageHeader, PageContent, type PageControls } from "../../components/page-layout.tsx";
import { SwitchField } from "../../components/form-fields.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import type { RecordsContext } from "../records-workspace.ts";

export interface SearchServices {
  service: Pick<VectorRetrievalService, "getState" | "subscribe" | "ranges" | "search" | "cancel">;
  assertContext: (context: RecordsContext) => void;
}
export interface SearchPageProps extends SearchServices {
  context: RecordsContext | null;
  controls: PageControls;
  active?: boolean;
  connection: EmbeddingConnection | undefined;
  onRecord: (tableId: MemoryTableId, recordId: MemoryRecordId) => void | Promise<void>;
  onIndex: () => void;
  onSettings: () => void;
  onBack?: () => void;
}

const running = (state: RetrievalState) =>
  state.status === "checking" || state.status === "embedding" || state.status === "sorting";
const statusLabels: Record<RetrievalState["status"], string> = {
  idle: "待搜索",
  checking: "检查索引",
  embedding: "生成查询向量",
  sorting: "整理结果",
  done: "搜索完成",
  cancelled: "搜索已取消",
  stale: "结果已过期",
  error: "搜索失败",
};

export function SearchPage(props: SearchPageProps) {
  const state = useSyncExternalStore(props.service.subscribe, props.service.getState);
  const scope = JSON.stringify([props.context?.chatKey, props.context?.spaceId]);
  const active = props.active ?? true;
  useEffect(() => {
    const cancel = () => {
      if (running(props.service.getState())) props.service.cancel();
    };
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    if (!active || document.hidden) cancel();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      cancel();
    };
  }, [props.service, active, scope]);
  return (
    <section className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="向量搜索"
        subtitle={props.context?.title}
        icon={Search}
        {...props.controls}
        onBack={props.onBack}
        actions={
          <Button variant="ghost" size="icon" aria-label="管理索引" onClick={props.onIndex}>
            <Database />
          </Button>
        }
      />
      <PageContent>
        {props.context ? (
          <SearchSession key={JSON.stringify([scope, state.epoch])} {...props} state={state} />
        ) : (
          <PageEmpty title="请先打开对话" description="绑定记忆空间后，可以搜索当前对话的记忆。" />
        )}
      </PageContent>
    </section>
  );
}

function SearchSession(props: SearchPageProps & { state: RetrievalState }) {
  const { service, state, context, connection } = props;
  const id = useId();
  const [query, setQuery] = useState(state.request?.query ?? "");
  const [topK, setTopK] = useState(String(state.request?.topK ?? 10));
  const [threshold, setThreshold] = useState(String(state.request?.minimumScore ?? ""));
  const [custom, setCustom] = useState(state.request?.selection !== null && !!state.request);
  const [selection, setSelection] = useState<readonly RetrievalSelection[]>(
    state.request?.selection ?? [],
  );
  const [ranges, setRanges] = useState<readonly RetrievalRange[]>([]);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const busy = running(state);
  const queryLimit = Math.min(4000, connection?.maxInputChars ?? 4000);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRangeError(null);
    void service.ranges(context!.spaceId).then(
      (rows) => {
        if (!cancelled) {
          setRanges(rows);
          setLoading(false);
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setRangeError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [service, context?.chatKey, context?.spaceId, state.dataVersion, reload]);
  useEffect(() => {
    if (!busy || state.startedAt === null) return;
    const started = state.startedAt;
    setElapsed(Date.now() - started);
    const timer = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(timer);
  }, [busy, state.startedAt]);

  async function search() {
    setError(null);
    try {
      props.assertContext(context!);
      await service.search({
        query,
        topK: Number(topK),
        minimumScore: threshold.trim() === "" ? null : Number(threshold),
        selection: custom ? selection : null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function openRecord(hit: RetrievalHit) {
    setOpening(true);
    setError(null);
    try {
      props.assertContext(context!);
      await props.onRecord(hit.target.table.id, hit.target.record.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpening(false);
    }
  }
  function toggleGroup(tableId: MemoryTableId, groupId: string, checked: boolean) {
    setSelection((previous) => {
      const current = previous.find((range) => range.tableId === tableId)?.groupIds ?? [];
      return [
        ...previous.filter((range) => range.tableId !== tableId),
        {
          tableId,
          groupIds: checked ? [...current, groupId] : current.filter((id) => id !== groupId),
        },
      ].filter((range) => range.groupIds.length > 0);
    });
  }
  const result = state.result;
  return (
    <div className="ste:mx-auto ste:flex ste:w-full ste:min-w-0 ste:max-w-3xl ste:flex-col ste:gap-5">
      {!connection ? (
        <PageEmpty
          title="先配置向量连接"
          description="配置 Embedding 连接并建立索引后，就能按含义检索记忆。"
        >
          <Button onClick={props.onSettings}>配置向量连接</Button>
        </PageEmpty>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
        className="ste:flex ste:flex-col ste:gap-4"
      >
        <Field data-disabled={busy}>
          <FieldLabel htmlFor={`${id}-query`}>想找什么记忆？</FieldLabel>
          <Textarea
            id={`${id}-query`}
            data-action="retrieval-query"
            rows={3}
            required
            maxLength={queryLimit}
            placeholder="描述人物、事件或你记得的片段…"
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
            aria-describedby={`${id}-query-description`}
          />
          <FieldDescription id={`${id}-query-description`}>
            {query.length}/{queryLimit} 字符 · 搜索当前对话中已有的向量索引。
          </FieldDescription>
        </Field>
        <div className="ste:flex ste:flex-wrap ste:gap-2">
          <Button
            type="submit"
            disabled={!connection || busy || loading}
            data-action="retrieval-search"
          >
            <Search data-icon="inline-start" />
            搜索记忆
          </Button>
          {busy ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => service.cancel()}
              data-action="retrieval-cancel"
            >
              取消搜索
            </Button>
          ) : null}
        </div>
        <Accordion>
          <AccordionItem>
            <AccordionTrigger>
              搜索选项 · 最多 {topK} 条 · {custom ? "自选范围" : "全部可用表"}
            </AccordionTrigger>
            <AccordionContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`${id}-top-k`}>最多返回条数</FieldLabel>
                  <Input
                    id={`${id}-top-k`}
                    data-action="retrieval-top-k"
                    type="number"
                    min={1}
                    max={50}
                    step={1}
                    required
                    value={topK}
                    disabled={busy}
                    onChange={(event) => setTopK(event.target.value)}
                  />
                  <FieldDescription>1–50 条，同一记录的多个分组合并显示。</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-threshold`}>最低相似度</FieldLabel>
                  <Input
                    id={`${id}-threshold`}
                    data-action="retrieval-threshold"
                    type="number"
                    min={-1}
                    max={1}
                    step="any"
                    placeholder="留空关闭"
                    value={threshold}
                    disabled={busy}
                    onChange={(event) => setThreshold(event.target.value)}
                  />
                  <FieldDescription>范围 -1 到 1；相似度分数不表示事实可信度。</FieldDescription>
                </Field>
                <SwitchField
                  label="自选搜索范围"
                  description="关闭时搜索当前空间全部可用索引。"
                  checked={custom}
                  disabled={busy || loading}
                  onCheckedChange={(value) => {
                    setCustom(value);
                    if (value && !selection.length)
                      setSelection(
                        ranges
                          .filter((range) => !range.error)
                          .map((range) => ({
                            tableId: range.table.id,
                            groupIds: range.groups
                              .filter((group) => !group.error)
                              .map((group) => group.id),
                          }))
                          .filter((range) => range.groupIds.length > 0),
                      );
                  }}
                />
                {custom
                  ? ranges
                      .filter((range) => !range.error)
                      .map((range) => (
                        <FieldSet key={range.table.id} disabled={busy}>
                          <FieldLegend variant="label">{range.table.name}</FieldLegend>
                          <FieldGroup>
                            {range.groups.map((group) => (
                              <Field
                                key={group.id}
                                orientation="horizontal"
                                data-disabled={busy || !!group.error}
                              >
                                <Checkbox
                                  id={`${id}-${range.table.id}-${group.id}`}
                                  disabled={busy || !!group.error}
                                  checked={selection.some(
                                    (selected) =>
                                      selected.tableId === range.table.id &&
                                      selected.groupIds.includes(group.id),
                                  )}
                                  onCheckedChange={(checked) =>
                                    toggleGroup(range.table.id, group.id, checked)
                                  }
                                />
                                <FieldLabel htmlFor={`${id}-${range.table.id}-${group.id}`}>
                                  {group.name}
                                  {group.error ? ` · ${group.error}` : ""}
                                </FieldLabel>
                              </Field>
                            ))}
                          </FieldGroup>
                        </FieldSet>
                      ))
                  : null}
              </FieldGroup>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </form>
      {loading ? <Skeleton className="ste:h-12 ste:w-full" /> : null}
      {rangeError ? (
        <PageError error={rangeError} onRetry={() => setReload((value) => value + 1)} />
      ) : null}
      {!loading && !rangeError && !ranges.some((range) => !range.error) ? (
        <PageEmpty
          title="还没有可检索的索引"
          description="在表格页开启向量索引并补建，再回来搜索。"
        >
          <Button variant="outline" onClick={props.onIndex}>
            管理索引
          </Button>
        </PageEmpty>
      ) : null}
      {ranges.some((range) => range.error) ? (
        <StatusNotice>
          {ranges
            .filter((range) => range.error)
            .map((range) => `${range.table.name}：${range.error}`)
            .join("；")}
        </StatusNotice>
      ) : null}
      {error ? <PageError title="操作失败" error={error} /> : null}
      {state.error ? (
        <StatusNotice variant={state.status === "error" ? "destructive" : "default"}>
          {state.error}
          {!busy ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!connection || loading}
              onClick={() => void search()}
            >
              重新搜索
            </Button>
          ) : null}
        </StatusNotice>
      ) : null}
      {state.status !== "idle" ? (
        <p
          role="status"
          data-retrieval-status={state.status}
          className="ste:text-sm ste:text-muted-foreground"
        >
          {statusLabels[state.status]}
          {busy
            ? ` · ${(elapsed / 1000).toFixed(1)} 秒`
            : state.elapsedMs !== null
              ? ` · ${(state.elapsedMs / 1000).toFixed(1)} 秒`
              : ""}
        </p>
      ) : null}
      {state.indexUpdated ? (
        <StatusNotice>索引已更新，重新搜索可使用最新索引。</StatusNotice>
      ) : null}
      {result ? (
        <section className="ste:flex ste:flex-col ste:gap-4" aria-label="检索结果">
          <div className="ste:flex ste:items-center ste:justify-between ste:gap-3">
            <h2 className="ste:text-base ste:font-semibold">
              {state.status === "stale" ? "已过期结果" : "搜索结果"}
            </h2>
            <Badge variant="secondary">{result.hits.length} 条</Badge>
          </div>
          {result.coverage.ready < result.coverage.expected ? (
            <StatusNotice>
              部分索引可用，结果可能遗漏。就绪 {result.coverage.ready}/{result.coverage.expected}
              ，缺失 {result.coverage.missing}，过期 {result.coverage.stale}，异常{" "}
              {result.coverage.invalid}。
            </StatusNotice>
          ) : null}
          {!result.hits.length ? (
            <PageEmpty title="没有匹配的记忆" description={result.message} />
          ) : (
            result.hits.map((hit) => (
              <Card
                size="sm"
                key={JSON.stringify([hit.target.table.id, hit.target.record.id])}
                data-retrieval-hit
              >
                <CardHeader>
                  <CardTitle className="ste:break-words">{hit.target.record.displayText}</CardTitle>
                  <CardDescription>
                    {hit.target.table.name} · 相似度 {hit.score.toFixed(4)} · {hit.groups.length}{" "}
                    个分组
                  </CardDescription>
                </CardHeader>
                <CardContent className="ste:flex ste:flex-col ste:gap-3">
                  <p className="ste:line-clamp-4 ste:whitespace-pre-wrap ste:break-words">
                    {hit.target.input}
                  </p>
                  <Accordion>
                    <AccordionItem>
                      <AccordionTrigger>字段内容与来源分组</AccordionTrigger>
                      <AccordionContent>
                        <HitDetails hit={hit} />
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </CardContent>
                <CardFooter>
                  <Button
                    variant="outline"
                    disabled={opening}
                    onClick={() => void openRecord(hit)}
                    data-action="retrieval-open-record"
                  >
                    查看记录与证据
                    <ArrowUpRight data-icon="inline-end" />
                  </Button>
                </CardFooter>
              </Card>
            ))
          )}
          <Accordion>
            <AccordionItem>
              <AccordionTrigger>索引覆盖与搜索详情</AccordionTrigger>
              <AccordionContent>
                <div className="ste:flex ste:flex-col ste:gap-3 ste:break-words">
                  <p>检查时间：{new Date(result.coverage.checkedAt).toLocaleString()}</p>
                  <p>
                    {result.coverage.records} 条记录 · 就绪 {result.coverage.ready}/
                    {result.coverage.expected} · 空输入 {result.coverage.empty} · 缺失{" "}
                    {result.coverage.missing} · 过期 {result.coverage.stale} · 异常{" "}
                    {result.coverage.invalid}
                  </p>
                  <p>
                    本地检查 {result.timing.check.toFixed(0)} ms · 查询{" "}
                    {result.timing.remote.toFixed(0)} ms · 排序 {result.timing.sort.toFixed(0)} ms ·
                    共 {result.timing.total.toFixed(0)} ms · 查询调用 {result.calls} 次
                  </p>
                  {[...result.coverage.issues, ...result.coverage.taskStates].map(
                    (issue, index) => (
                      <p key={index}>{issue}</p>
                    ),
                  )}
                  <Button variant="outline" onClick={props.onIndex}>
                    管理与补建索引
                  </Button>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </section>
      ) : null}
      <p className="ste:text-xs ste:text-muted-foreground ste:break-words">
        {connection ? `Embedding：${connection.model}。` : ""}
        每次搜索最多请求一次查询向量。取消或离开页面会停止等待，已发送的请求仍可能计费。
      </p>
    </div>
  );
}

function HitDetails({ hit }: { hit: RetrievalHit }) {
  return (
    <div className="ste:flex ste:flex-col ste:gap-4">
      <dl className="ste:flex ste:flex-col ste:gap-3">
        {hit.target.fields.map((field) => (
          <div key={field.id}>
            <dt className="ste:text-xs ste:text-muted-foreground">{field.name}</dt>
            <dd className="ste:mt-1 ste:whitespace-pre-wrap ste:break-words">
              {recordFieldValueText(field, hit.target.record.payload[field.id])}
            </dd>
          </div>
        ))}
      </dl>
      {hit.groups.map((group) => (
        <div key={group.target.groupId} className="ste:flex ste:flex-col ste:gap-2">
          <h3 className="ste:text-sm ste:font-medium">
            {group.target.groupName} · {group.score.toFixed(4)}
          </h3>
          <p className="ste:text-xs ste:text-muted-foreground">
            字段：{group.target.fields.map((field) => field.name).join("、")} · 索引更新{" "}
            {new Date(group.vector.updatedAt).toLocaleString()}
          </p>
          <p className="ste:whitespace-pre-wrap ste:break-words">{group.target.input}</p>
        </div>
      ))}
    </div>
  );
}
