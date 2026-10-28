import { PageHeader, PageContent, PageFooter } from "../components/page-layout.tsx";
import { usePageLeave, type RegisterLeaveGuard } from "../components/confirmation.tsx";
import { RecordDetailPage } from "./record-detail.tsx";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useId } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  LoaderCircle,
  List,
  Plus,
  RefreshCw,
  Search,
  Table2,
} from "lucide-react";
import type { MemoryRecordId, MemoryTableId } from "../../features/memory/index.ts";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import type { ChatMirrorStatus } from "../../features/chat-mirror/chat-metadata-mirror-sync.ts";
import type {
  StChatMessage,
  FloorJumpResult,
} from "../../infrastructure/sillytavern/chat-adapter.ts";
import type { RecordsWorkspace } from "./records-workspace.ts";
import { recordPreview, referenceLabels } from "../components/record-fields.tsx";
import { RecordSortMenu } from "../components/record-sort-menu.tsx";
import { RecordsTable } from "../components/records-table.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../ui/primitives/tabs.tsx";
import { cn } from "../../ui/primitives/utils.ts";
import { Button } from "../../ui/primitives/button.tsx";
import { Input } from "../../ui/primitives/input.tsx";
import { NativeSelect } from "../../ui/primitives/native-select.tsx";
import { Field } from "../../ui/primitives/field.tsx";
import { Alert, AlertDescription, AlertTitle } from "../../ui/primitives/alert.tsx";
import { Skeleton } from "../../ui/primitives/skeleton.tsx";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "../../ui/primitives/empty.tsx";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../ui/primitives/item.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "../../ui/primitives/pagination.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/primitives/popover.tsx";

export interface RecordsPageProps {
  registerLeaveGuard?: RegisterLeaveGuard;
  workspace: RecordsWorkspace;
  status: SpaceContextStatus | undefined;
  mirror: ChatMirrorStatus;
  onClose: () => void;
  onToggleTone: () => void;
  onRetryContext: () => Promise<unknown>;
  onResolveBranch: (action: "create" | "clone") => Promise<unknown>;
  onRetrySave: () => Promise<unknown>;
  getMessageAt: (floor: number) => StChatMessage | undefined;
  onJumpFloor: (floor: number) => FloorJumpResult;
}

interface RecordsPosition {
  top: number;
  left: number;
  recordId: MemoryRecordId | null;
  fieldId: string | null;
}
const recordPositions = new WeakMap<RecordsWorkspace, Map<string, RecordsPosition>>();

export function RecordsPage(props: RecordsPageProps) {
  const { workspace } = props;
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const hostOperation = useRef(0);
  const [search, setSearch] = useState(state.search);
  const [pageInput, setPageInput] = useState(String(state.page));
  const [paginationOpen, setPaginationOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const listPosition = recordPositions.get(workspace) ?? new Map<string, RecordsPosition>();
  recordPositions.set(workspace, listPosition);
  const viewKey = state.context
    ? JSON.stringify([
        state.context.chatKey,
        state.context.spaceId,
        state.tableId,
        state.page,
        state.pageSize,
        state.search,
        state.order.fieldId,
        state.order.direction,
        state.viewMode,
      ])
    : "";
  const showingDetail = state.detailId !== null || state.editor !== null;
  const labels = referenceLabels(state.references);
  const totalPages = Math.max(1, state.records?.totalPages ?? 1);
  const formId = useId();

  useEffect(() => {
    setSearch(state.search);
  }, [state.context?.chatKey, state.context?.spaceId, state.tableId]);
  useEffect(() => {
    setPageInput(String(state.page));
  }, [state.page]);
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (state.context && search.trim() !== state.search) void workspace.setSearch(search.trim());
    }, 250);
    return () => clearTimeout(timeout);
  }, [search, state.context, state.search, workspace]);
  useEffect(() => {
    setHostError(null);
    setHostBusy(false);
    hostOperation.current++;
  }, [state.context?.chatKey, state.context?.spaceId]);

  useLayoutEffect(() => {
    if (showingDetail) {
      if (state.editor)
        formRef.current
          ?.querySelector<HTMLElement>("input, textarea, select, button[role=switch]")
          ?.focus();
      else detailRef.current?.focus();
    }
  }, [
    showingDetail,
    !!state.editor,
    state.detailId,
    state.context?.chatKey,
    state.context?.spaceId,
  ]);
  useLayoutEffect(() => {
    if (!showingDetail && listRef.current && !state.listLoading) {
      const previous = listPosition.get(viewKey);
      listRef.current.scrollTop = previous?.top ?? 0;
      listRef.current.scrollLeft = previous?.left ?? 0;
      if (previous?.recordId)
        listRef.current
          .querySelector<HTMLButtonElement>(
            `[data-record-id="${CSS.escape(previous.recordId)}"]${previous.fieldId ? `[data-record-field="${CSS.escape(previous.fieldId)}"]` : ""}`,
          )
          ?.focus({ preventScroll: true });
    }
  }, [showingDetail, state.listLoading, viewKey, listPosition]);
  useEffect(() => {
    if (state.editor && Object.keys(state.editor.errors).length)
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state.editor?.errors]);

  const { requestLeave: navigate, confirmation } = usePageLeave({
    dirty: !!state.editor?.dirty,
    busy: state.saving,
    scope: JSON.stringify([state.context?.chatKey, state.context?.spaceId]),
    discard: () => workspace.cancelEdit(),
    register: props.registerLeaveGuard,
  });
  async function runHost(action: () => Promise<unknown>) {
    if (hostBusy) return;
    const operation = ++hostOperation.current;
    setHostError(null);
    setHostBusy(true);
    try {
      await action();
    } catch (error) {
      if (operation === hostOperation.current)
        setHostError(error instanceof Error ? error.message : String(error));
    } finally {
      if (operation === hostOperation.current) setHostBusy(false);
    }
  }
  function openRecord(id: MemoryRecordId, fieldId: string | null = null) {
    listPosition.set(viewKey, {
      top: listRef.current!.scrollTop,
      left: listRef.current!.scrollLeft,
      recordId: id,
      fieldId,
    });
    navigate(() => void workspace.openRecord(id, fieldId === null ? "detail" : "edit"));
  }
  function changePage(page: number) {
    listRef.current?.scrollTo({ top: 0 });
    void workspace.setPage(page);
  }

  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col ste:text-sm">
      <PageHeader
        title={
          state.editor
            ? state.editor.original
              ? "编辑记录"
              : "新建记录"
            : showingDetail
              ? "记录详情"
              : "记忆记录"
        }
        subtitle={state.context?.title ?? "当前对话"}
        busy={state.saving}
        onBack={showingDetail ? () => navigate(() => workspace.closeDetail()) : undefined}
        backLabel="返回记录"
        backAction="back-to-records"
        onClose={props.onClose}
        onToggleTone={props.onToggleTone}
        actions={
          !showingDetail && state.context ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新记录"
              disabled={state.listLoading}
              onClick={() => void workspace.refresh()}
            >
              <RefreshCw />
            </Button>
          ) : null
        }
      />

      {props.mirror.kind !== "idle" ? (
        <div
          className="ste:shrink-0 ste:border-b ste:border-border ste:px-4 ste:py-2 ste:text-xs ste:text-muted-foreground"
          aria-live="polite"
        >
          {props.mirror.kind === "saving" ? (
            "正在写入对话文件…"
          ) : props.mirror.kind === "failed" ? (
            <span className="ste:text-destructive">
              对话文件尚未保存：{props.mirror.error}{" "}
              <Button
                variant="link"
                size="xs"
                disabled={hostBusy || !state.context}
                onClick={() => void runHost(() => workspace.retryPersistence(props.onRetrySave))}
              >
                重试写回
              </Button>
            </span>
          ) : (
            "本地记忆 · 对话文件同步已关闭"
          )}
        </div>
      ) : null}

      {hostError ? (
        <Alert variant="destructive" className="ste:shrink-0">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{hostError}</AlertDescription>
        </Alert>
      ) : null}
      {!state.context ? (
        <Empty className="ste:m-auto ste:max-w-lg">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpen />
            </EmptyMedia>
            <EmptyTitle>
              {props.status?.kind === "branch-detected"
                ? "为分支对话准备记忆"
                : !props.status
                  ? "正在切换对话"
                  : "记忆暂不可用"}
            </EmptyTitle>
            <EmptyDescription>
              {props.status?.kind === "branch-detected"
                ? "可以复制原对话的记忆，也可以从默认表格预设开始。"
                : props.status && "humanMsg" in props.status
                  ? props.status.humanMsg
                  : "正在载入当前对话的记忆空间。"}
            </EmptyDescription>
          </EmptyHeader>
          {props.status?.kind === "branch-detected" ? (
            <EmptyContent>
              <Button
                disabled={hostBusy}
                onClick={() => void runHost(() => props.onResolveBranch("clone"))}
              >
                复制原有记忆
              </Button>
              <Button
                variant="outline"
                disabled={hostBusy}
                onClick={() => void runHost(() => props.onResolveBranch("create"))}
              >
                创建空白记忆
              </Button>
            </EmptyContent>
          ) : props.status ? (
            <EmptyContent>
              <Button
                variant="outline"
                disabled={hostBusy}
                onClick={() => void runHost(props.onRetryContext)}
              >
                重新加载
              </Button>
            </EmptyContent>
          ) : (
            <LoaderCircle className="ste:size-5 ste:animate-spin" />
          )}
          {state.retainedDraftCount > 0 ? (
            <EmptyDescription>
              其他对话有未保存修改，返回原对话后继续编辑。本次打开期间保留。
            </EmptyDescription>
          ) : null}
        </Empty>
      ) : (
        <>
          {state.notice || state.retainedDraftCount > 0 ? (
            <p role="status" className="ste:shrink-0 ste:bg-muted ste:px-4 ste:py-2 ste:text-xs">
              {state.notice ??
                `其他对话有 ${state.retainedDraftCount} 份未保存修改，返回原对话后可继续。本次打开期间保留。`}
            </p>
          ) : null}
          <Tabs
            value={state.viewMode}
            onValueChange={(value) => {
              if (value === "list" || value === "table") workspace.setViewMode(value);
            }}
            hidden={showingDetail}
            className={cn(
              "ste:min-h-0 ste:min-w-0 ste:flex-1 ste:gap-0 ste:overflow-hidden",
              showingDetail && "ste:hidden",
            )}
          >
            <PageContent className="ste:flex ste:min-w-0 ste:flex-col ste:overflow-hidden">
              <div className="ste:mb-4 ste:flex ste:shrink-0 ste:flex-col ste:gap-3">
                <div className="ste:flex ste:items-center ste:gap-2">
                  <Field className="ste:min-w-0 ste:flex-1">
                    <NativeSelect
                      id="ste-record-table"
                      aria-label="记忆表格"
                      className="ste:w-full"
                      value={state.tableId ?? ""}
                      disabled={state.listLoading || state.tables.length === 0}
                      onChange={(event) =>
                        navigate(
                          () => void workspace.selectTable(event.target.value as MemoryTableId),
                        )
                      }
                    >
                      {state.tables.length === 0 ? <option value="">暂无表格</option> : null}
                      {state.tables.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.enabled ? "" : "（已停用）"}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <TabsList aria-label="记录展示方式" className="ste:shrink-0">
                    <TabsTrigger
                      value="list"
                      aria-label="列表"
                      className="ste:h-7 ste:w-7 ste:flex-none ste:p-0"
                    >
                      <List />
                    </TabsTrigger>
                    <TabsTrigger
                      value="table"
                      aria-label="表格"
                      className="ste:h-7 ste:w-7 ste:flex-none ste:p-0"
                    >
                      <Table2 />
                    </TabsTrigger>
                  </TabsList>
                  <Button
                    aria-label="新建记录"
                    data-action="create-record"
                    disabled={!state.tableId || state.listLoading || !!state.listError}
                    onClick={() => navigate(() => workspace.startCreate())}
                  >
                    <Plus data-icon="inline-start" />
                    新建
                  </Button>
                </div>
                <div className="ste:flex ste:items-end ste:gap-2">
                  <Field className="ste:min-w-0 ste:flex-1">
                    <div className="ste:relative">
                      <Search className="ste:pointer-events-none ste:absolute ste:top-1/2 ste:left-3 ste:size-4 ste:-translate-y-1/2 ste:text-muted-foreground" />
                      <Input
                        id="ste-record-search"
                        type="search"
                        className="ste:pl-9"
                        aria-label="搜索记录"
                        placeholder="搜索当前表的记录"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                  </Field>
                  <RecordSortMenu
                    fields={state.fields}
                    order={state.order}
                    disabled={!state.tableId || state.listLoading || hostBusy}
                    onSelect={(fieldId) =>
                      navigate(() => {
                        listRef.current!.scrollTop = 0;
                        void runHost(() => workspace.setSort(fieldId));
                      })
                    }
                  />
                </div>
              </div>
              <TabsContent
                value={state.viewMode}
                className="ste:flex ste:min-h-0 ste:min-w-0 ste:flex-col"
              >
                <div
                  key={viewKey}
                  ref={listRef}
                  data-slot="records-scroll"
                  className={cn(
                    "ste:min-h-0 ste:min-w-0 ste:flex-1 ste:overflow-auto ste:overscroll-contain",
                    state.viewMode === "table" && "ste:rounded-xl ste:border ste:border-border",
                  )}
                  onScroll={(event) => {
                    if (showingDetail || state.listLoading) return;
                    const previous = listPosition.get(viewKey);
                    listPosition.set(viewKey, {
                      top: event.currentTarget.scrollTop,
                      left: event.currentTarget.scrollLeft,
                      recordId: previous?.recordId ?? null,
                      fieldId: previous?.fieldId ?? null,
                    });
                  }}
                >
                  {state.listError ? (
                    <Alert variant="destructive">
                      <AlertTitle>记录加载失败</AlertTitle>
                      <AlertDescription>
                        {state.listError}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void workspace.refresh()}
                        >
                          重新加载
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {state.listLoading ? (
                    <div aria-label="正在加载记录" className="ste:flex ste:flex-col ste:gap-3">
                      {[0, 1, 2, 3].map((item) => (
                        <Skeleton key={item} className="ste:h-24 ste:w-full ste:rounded-2xl" />
                      ))}
                    </div>
                  ) : state.records?.records.length ? (
                    state.viewMode === "table" ? (
                      <RecordsTable
                        fields={state.fields}
                        records={state.records.records}
                        labels={labels}
                        offset={(state.page - 1) * state.pageSize}
                        onEdit={openRecord}
                      />
                    ) : (
                      <ItemGroup
                        aria-label="记录列表"
                        className="ste:gap-0 ste:divide-y ste:divide-border ste:overflow-hidden ste:rounded-xl ste:border ste:border-border"
                      >
                        {state.records.records.map((record) => (
                          <div key={record.id} role="listitem">
                            <Item
                              render={<button type="button" />}
                              className="ste:cursor-pointer ste:rounded-none ste:px-4 ste:py-2.5 ste:text-left ste:hover:bg-muted/60 ste:focus-visible:ring-inset"
                              data-action="open-record"
                              data-record-id={record.id}
                              onClick={() => openRecord(record.id)}
                            >
                              <ItemContent>
                                <ItemTitle>{record.displayText}</ItemTitle>
                                <ItemDescription className="ste:line-clamp-1">
                                  {recordPreview(record, state.fields, labels) || "暂无更多内容"}
                                </ItemDescription>
                              </ItemContent>
                              <ItemActions>
                                <ChevronRight className="ste:size-4 ste:text-muted-foreground" />
                              </ItemActions>
                            </Item>
                          </div>
                        ))}
                      </ItemGroup>
                    )
                  ) : !state.listError ? (
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <FileText />
                        </EmptyMedia>
                        <EmptyTitle>{state.search ? "没有匹配的记录" : "还没有记录"}</EmptyTitle>
                        <EmptyDescription>
                          {state.search
                            ? "试试其他关键词，或清空搜索查看全部记录。"
                            : "新建第一条记录，开始整理这段对话的记忆。"}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  ) : null}
                </div>
              </TabsContent>
            </PageContent>
          </Tabs>

          {showingDetail ? (
            <RecordDetailPage
              state={state}
              workspace={workspace}
              detailRef={detailRef}
              formRef={formRef}
              formId={formId}
              navigate={navigate}
              runHost={runHost}
              getMessageAt={props.getMessageAt}
              onJumpFloor={props.onJumpFloor}
              onRetrySave={() => runHost(() => workspace.retryPersistence(props.onRetrySave))}
            />
          ) : null}
          {!showingDetail ? (
            <PageFooter className="ste:px-3 ste:py-2">
              <Pagination aria-label="记录分页" className="ste:mx-0 ste:w-full">
                <PaginationContent className="ste:w-full ste:flex-nowrap ste:justify-between">
                  <PaginationItem>
                    <PaginationPrevious
                      text=""
                      size="icon"
                      aria-label="上一页"
                      disabled={state.listLoading || state.page <= 1}
                      onClick={() => changePage(state.page - 1)}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <Popover
                      open={paginationOpen}
                      onOpenChange={(open) => {
                        setPaginationOpen(open);
                        if (open) setPageInput(String(state.page));
                      }}
                    >
                      <PopoverTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ste:bg-muted/50 ste:px-2.5 ste:text-xs ste:font-normal ste:hover:bg-muted"
                          />
                        }
                        aria-label={`分页设置，第 ${state.page}/${totalPages} 页，共 ${state.records?.total ?? 0} 条`}
                      >
                        <span className="ste:whitespace-nowrap">
                          {state.page}/{totalPages} · {state.records?.total ?? 0} 条
                        </span>
                        <ChevronDown className="ste:size-3 ste:opacity-70" aria-hidden />
                      </PopoverTrigger>
                      <PopoverContent aria-label="分页设置" side="top" className="ste:w-64">
                        <div className="ste:flex ste:flex-col ste:gap-2">
                          <span className="ste:text-xs ste:font-medium ste:text-muted-foreground">
                            每页条数
                          </span>
                          <NativeSelect
                            size="sm"
                            aria-label="每页条数"
                            className="ste:w-full"
                            value={String(state.pageSize)}
                            disabled={state.listLoading || !state.records}
                            onChange={(event) => {
                              listRef.current?.scrollTo({ top: 0 });
                              void workspace.setPageSize(Number(event.target.value));
                            }}
                          >
                            {[10, 20, 50, 100].map((size) => (
                              <option key={size} value={size}>
                                {size} 条/页
                              </option>
                            ))}
                          </NativeSelect>
                        </div>
                        <form
                          className="ste:flex ste:flex-col ste:gap-2"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const requested = Number.parseInt(pageInput, 10);
                            const target = Number.isInteger(requested)
                              ? Math.min(Math.max(requested, 1), totalPages)
                              : state.page;
                            setPageInput(String(target));
                            setPaginationOpen(false);
                            if (target !== state.page) changePage(target);
                          }}
                        >
                          <span className="ste:text-xs ste:font-medium ste:text-muted-foreground">
                            跳转页码
                          </span>
                          <div className="ste:flex ste:items-center ste:gap-2">
                            <Input
                              aria-label="跳转页码"
                              className="ste:h-8 ste:min-w-0 ste:flex-1 ste:text-center"
                              inputMode="numeric"
                              placeholder={`1–${totalPages}`}
                              value={pageInput}
                              disabled={state.listLoading || totalPages <= 1}
                              onChange={(event) =>
                                setPageInput(event.target.value.replace(/\D/g, ""))
                              }
                              onBlur={() => {
                                if (pageInput === "") setPageInput(String(state.page));
                              }}
                            />
                            <Button
                              type="submit"
                              size="sm"
                              disabled={state.listLoading || totalPages <= 1}
                            >
                              跳转
                            </Button>
                          </div>
                        </form>
                      </PopoverContent>
                    </Popover>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      text=""
                      size="icon"
                      aria-label="下一页"
                      disabled={state.listLoading || !state.records || state.page >= totalPages}
                      onClick={() => changePage(state.page + 1)}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </PageFooter>
          ) : null}
        </>
      )}
      {confirmation}
    </div>
  );
}
