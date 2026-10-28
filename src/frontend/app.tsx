import { PageHeader, PageContent, PageFooter } from "./components/page-layout.tsx";
import { usePageLeave, type RegisterLeaveGuard } from "./components/confirmation.tsx";
import { RecordDetailPage } from "./pages/record-detail.tsx";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useId } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type { MemoryRecordId, MemoryTableId } from "../features/memory/index.ts";
import type { SpaceContextStatus } from "../features/chat-binding/chat-space-manager.ts";
import type { ChatMirrorStatus } from "../features/chat-mirror/chat-metadata-mirror-sync.ts";
import type { StChatMessage, FloorJumpResult } from "../infrastructure/sillytavern/chat-adapter.ts";
import type { RecordsWorkspace } from "./pages/records-workspace.ts";
import { recordPreview, referenceLabels } from "./components/record-fields.tsx";
import { RecordSortMenu } from "./components/record-sort-menu.tsx";
import { recordSortOptions } from "../ui/memory/record-sort-model.ts";
import { Button } from "../ui/primitives/button.tsx";
import { Input } from "../ui/primitives/input.tsx";
import { NativeSelect } from "../ui/primitives/native-select.tsx";
import { Field, FieldLabel } from "../ui/primitives/field.tsx";
import { Alert, AlertDescription, AlertTitle } from "../ui/primitives/alert.tsx";
import { Skeleton } from "../ui/primitives/skeleton.tsx";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "../ui/primitives/empty.tsx";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../ui/primitives/item.tsx";

export interface RecordsAppProps {
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

export function RecordsApp(props: RecordsAppProps) {
  const { workspace } = props;
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const hostOperation = useRef(0);
  const [search, setSearch] = useState(state.search);
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const listPosition = useRef(new Map<string, { top: number; recordId: MemoryRecordId | null }>());
  const viewKey = state.context
    ? JSON.stringify([
        state.context.chatKey,
        state.context.spaceId,
        state.tableId,
        state.page,
        state.search,
        state.order.fieldId,
        state.order.direction,
      ])
    : "";
  const showingDetail = state.detailId !== null || state.editor !== null;
  const labels = referenceLabels(state.references);
  const formId = useId();

  useEffect(() => {
    setSearch(state.search);
  }, [state.context?.chatKey, state.context?.spaceId, state.tableId]);
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
    } else if (listRef.current) {
      const previous = listPosition.current.get(viewKey);
      listRef.current.scrollTop = previous?.top ?? 0;
      if (previous?.recordId)
        listRef.current
          .querySelector<HTMLButtonElement>(`[data-record-id="${CSS.escape(previous.recordId)}"]`)
          ?.focus({ preventScroll: true });
    }
  }, [showingDetail, !!state.editor, state.detailId, state.context?.chatKey]);
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
  function openRecord(id: MemoryRecordId) {
    listPosition.current.set(viewKey, { top: listRef.current?.scrollTop ?? 0, recordId: id });
    navigate(() => void workspace.openRecord(id));
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
        ) : props.mirror.kind === "disabled" ? (
          "本地记忆 · 对话文件同步已关闭"
        ) : (
          "记忆随当前对话保存"
        )}
      </div>

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
          <PageContent
            ref={listRef}
            hidden={showingDetail}
            className="ste:min-h-0 ste:flex-1 ste:overflow-y-auto ste:overscroll-contain ste:p-4"
          >
            <div className="ste:mb-5 ste:flex ste:flex-col ste:gap-4">
              <div className="ste:flex ste:items-end ste:gap-3">
                <Field className="ste:flex-1">
                  <FieldLabel htmlFor="ste-record-table">记忆表格</FieldLabel>
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
              <div className="ste:flex ste:items-center ste:justify-between ste:gap-3 ste:text-xs ste:text-muted-foreground">
                <span className="ste:shrink-0">{state.records?.total ?? 0} 条记录</span>
                <span className="ste:text-right ste:break-words">
                  按
                  {
                    recordSortOptions(state.fields).find(
                      (option) => option.fieldId === state.order.fieldId,
                    )!.label
                  }
                  {state.order.direction === "asc" ? "升序" : "降序"}排列
                </span>
              </div>
            </div>
            {state.listError ? (
              <Alert variant="destructive">
                <AlertTitle>记录加载失败</AlertTitle>
                <AlertDescription>
                  {state.listError}
                  <Button variant="outline" size="sm" onClick={() => void workspace.refresh()}>
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
              <ItemGroup aria-label="记录列表">
                {state.records.records.map((record) => (
                  <div key={record.id} role="listitem">
                    <Item
                      variant="outline"
                      render={<button type="button" />}
                      className="ste:cursor-pointer ste:text-left ste:hover:bg-muted"
                      data-action="open-record"
                      data-record-id={record.id}
                      onClick={() => openRecord(record.id)}
                    >
                      <ItemContent>
                        <ItemTitle>{record.displayText}</ItemTitle>
                        <ItemDescription className="ste:line-clamp-2">
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
          </PageContent>

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
            <PageFooter
              className="ste:flex ste:shrink-0 ste:items-center ste:justify-between ste:border-t ste:border-border ste:p-3"
              aria-label="记录分页"
            >
              <Button
                variant="ghost"
                size="sm"
                aria-label="上一页"
                disabled={state.listLoading || state.page <= 1}
                onClick={() => void workspace.setPage(state.page - 1)}
              >
                <ChevronLeft />
                上一页
              </Button>
              <span className="ste:text-xs ste:text-muted-foreground">
                第 {state.page} / {Math.max(1, state.records?.totalPages ?? 1)} 页
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="下一页"
                disabled={
                  state.listLoading || !state.records || state.page >= state.records.totalPages
                }
                onClick={() => void workspace.setPage(state.page + 1)}
              >
                下一页
                <ChevronRight />
              </Button>
            </PageFooter>
          ) : null}
        </>
      )}
      {confirmation}
    </div>
  );
}
