import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ChevronDown, ListTodo } from "lucide-react";
import type { FillTaskView } from "../../../features/fill-tasks/fill-task.ts";
import type { SettingsService } from "../../../features/settings/settings-service.ts";
import type { VectorTaskStatus } from "../../../features/vector-index/types.ts";
import { Button } from "../../primitives/button.tsx";
import { Badge } from "../../primitives/badge.tsx";
import { Checkbox } from "../../primitives/checkbox.tsx";
import { Field, FieldLabel } from "../../primitives/field.tsx";
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia } from "../../primitives/item.tsx";
import { Input } from "../../primitives/input.tsx";
import { NativeSelect } from "../../primitives/native-select.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../primitives/tabs.tsx";
import { Textarea } from "../../primitives/textarea.tsx";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../primitives/accordion.tsx";
import { PageSection } from "../../components/page-section.tsx";
import { formatCompactTime } from "../../components/format-time.ts";
import {
  buildCoverageViewModel,
  taskRangeText,
  taskStatusViewModel,
  unprocessedRanges,
} from "../../models/tasks/task-panel-model.ts";
import { PageContent, PageHeader, type PageControls } from "../../components/page-layout.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import {
  ConfirmAction,
  usePageLeave,
  type RegisterLeaveGuard,
} from "../../components/confirmation.tsx";
import type { FillSubmitSummary } from "./task-submit-summary.ts";
import {
  agentPresetLabel,
  buildFillSubmitSummary,
  cleaningRuleLabel,
  isCleaningRuleDisabled,
} from "./task-submit-summary.ts";
import { CoverageBar, TaskProgressBar } from "./task-progress.tsx";
import { TaskChatConfig } from "./task-chat-config.tsx";
import type { AutoFillServices } from "./auto-fill-overrides.tsx";
import { AutoFillOverrides } from "./auto-fill-overrides.tsx";
import type { TasksSnapshot, TasksWorkspace } from "./tasks-workspace.ts";

const vectorLabels: Record<VectorTaskStatus, string> = {
  queued: "等待中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  obsolete: "已过期",
  cancelled: "已取消",
  interrupted: "已中断",
};
const autoFillModeLabels = { off: "关闭", remind: "仅提醒", auto: "自动填表" } as const;

interface TasksPageProps {
  workspace: TasksWorkspace;
  autoFill: AutoFillServices;
  settings: Pick<SettingsService, "read">;
  onOpenLog: (key: string, summary?: string) => void;
  controls: PageControls;
  registerLeaveGuard?: RegisterLeaveGuard;
  active?: boolean;
}

export function TasksPage(props: TasksPageProps) {
  const [overrides, setOverrides] = useState(false);
  return overrides ? (
    <AutoFillOverrides {...props} onBack={() => setOverrides(false)} />
  ) : (
    <TasksMain {...props} onAutoFill={() => setOverrides(true)} />
  );
}

function TasksMain({
  workspace,
  autoFill,
  settings,
  controls,
  registerLeaveGuard,
  active = true,
  onAutoFill,
  onOpenLog,
}: TasksPageProps & { onAutoFill: () => void }) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const scope = JSON.stringify([state.context?.chatKey, state.context?.spaceId]);
  const defaultBlock = String(autoFill.settings().blockSize);
  const [range, setRange] = useState({ from: "", to: "", block: defaultBlock });
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState<FillSubmitSummary | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const prefilledScope = useRef<string | null>(null);
  useEffect(() => (active ? workspace.startPolling() : undefined), [workspace, active]);
  useEffect(() => {
    setRange({ from: "", to: "", block: String(autoFill.settings().blockSize) });
    setRangeError(null);
    setPendingSubmit(null);
    setShowAllHistory(false);
  }, [autoFill, scope]);
  useEffect(() => {
    if (!state.context || state.loading || prefilledScope.current === scope) return;
    prefilledScope.current = scope;
    const first = unprocessedRanges(state.ledger, state.messageCount)[0];
    setRange({
      from: first ? String(first.from) : "",
      to: first ? String(first.to) : "",
      block: String(autoFill.settings().blockSize),
    });
  }, [autoFill, scope, state.context, state.ledger, state.loading, state.messageCount]);
  const { requestLeave, confirmation } = usePageLeave({
    dirty: !!state.draft,
    busy: state.busy,
    scope,
    discard: workspace.discard,
    register: registerLeaveGuard,
  });
  const currentSettings = settings.read();
  const coverage = buildCoverageViewModel({
    ledger: state.ledger,
    chatLength: state.messageCount,
    activeRange: undefined,
    plannedRanges: state.pending.filter(
      (task) => task.kind === "floor" && (task.status === "queued" || task.status === "running"),
    ),
  });
  const firstUnprocessed = unprocessedRanges(state.ledger, state.messageCount)[0];
  const running = state.pending.find((task) => task.status === "running");
  const queued = state.pending.filter((task) => task.status !== "running");
  const history = state.history.filter(
    (task) => !state.pending.some((pending) => pending.runId === task.runId),
  );
  const visibleHistory = showAllHistory ? history : history.slice(0, 5);
  const cleaningLabel = cleaningRuleLabel(currentSettings.cleaningRules, state.cleaningSelection);
  const presetLabel = agentPresetLabel(currentSettings.agentPresets, state.agentPresetOverride);
  const cleaningDisabled = isCleaningRuleDisabled(
    currentSettings.cleaningRules,
    state.cleaningSelection,
  );
  const autoFillMode = autoFillModeLabels[autoFill.settings().mode];
  const autoFillOverridden = Object.keys(autoFill.read().overrides).length > 0;
  const autoFillSummary = `${autoFillOverridden ? "本对话覆盖" : "跟随全局"} · ${autoFillMode} · 每 ${autoFill.settings().interval} 层`;

  function requestFill(event: FormEvent) {
    event.preventDefault();
    const result = buildFillSubmitSummary({
      fromText: range.from,
      toText: range.to,
      blockText: range.block,
      chatLength: state.messageCount,
      ledger: state.ledger,
      pending: state.pending,
    });
    if (result.kind === "error") {
      setRangeError(result.message);
      return;
    }
    setRangeError(null);
    setPendingSubmit(result.summary);
  }
  async function confirmFill() {
    if (!pendingSubmit) return;
    const outcome = await workspace.submitFloors(
      String(pendingSubmit.from),
      String(pendingSubmit.to),
      String(pendingSubmit.blockSize),
    );
    if (!outcome.ok) throw new Error(outcome.error);
    setPendingSubmit(null);
  }
  function useFirstUnprocessed() {
    if (!firstUnprocessed) return;
    setRange({
      from: String(firstUnprocessed.from),
      to: String(firstUnprocessed.to),
      block: range.block || defaultBlock,
    });
    setRangeError(null);
    document.getElementById("task-from")?.focus();
  }

  return (
    <section className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader
        title="任务"
        subtitle={state.context?.title}
        icon={ListTodo}
        busy={state.busy}
        {...controls}
      />
      <PageContent className="ste:space-y-4">
        {!state.context ? (
          <PageEmpty
            title="请先打开对话"
            description="绑定记忆空间后，可以提交填表任务并查看向量索引进度。"
          />
        ) : (
          <Tabs defaultValue="fill" className="ste:gap-4">
            <TabsList aria-label="任务类型">
              <TabsTrigger value="fill">填表任务</TabsTrigger>
              <TabsTrigger value="vector">向量任务</TabsTrigger>
            </TabsList>
            {state.loadError && (
              <PageError error={state.loadError} onRetry={() => void workspace.refresh()} />
            )}
            {state.error && (
              <PageError
                title="任务操作失败"
                error={state.error}
                onRetry={() => void workspace.refresh()}
              />
            )}
            {state.notice && <StatusNotice>{state.notice}</StatusNotice>}
            <TabsContent value="fill" className="ste:space-y-4">
              <ProgressSection
                coverage={coverage}
                running={running}
                last={history[0]}
                firstUnprocessed={firstUnprocessed}
                busy={state.busy}
                onUseRange={useFirstUnprocessed}
                onOpenLog={onOpenLog}
                onCancel={(task) => void workspace.fillAction(task.runId, "cancel")}
                onRetry={(task) => void workspace.fillAction(task.runId, "retry")}
              />
              <PageSection
                title="手动填表"
                meta={
                  <span className="ste:text-xs ste:text-muted-foreground">
                    共 {state.messageCount} 层
                  </span>
                }
              >
                <form className="ste:flex ste:flex-col ste:gap-3" onSubmit={requestFill}>
                  <div className="ste:grid ste:grid-cols-2 ste:gap-3 ste:sm:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor="task-from">起始楼层</FieldLabel>
                      <Input
                        id="task-from"
                        inputMode="numeric"
                        placeholder="0"
                        value={range.from}
                        onChange={(event) => {
                          setRange({ ...range, from: event.target.value });
                          setRangeError(null);
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="task-to">结束楼层</FieldLabel>
                      <Input
                        id="task-to"
                        inputMode="numeric"
                        placeholder={String(Math.max(0, state.messageCount - 1))}
                        value={range.to}
                        onChange={(event) => {
                          setRange({ ...range, to: event.target.value });
                          setRangeError(null);
                        }}
                      />
                    </Field>
                    <Field className="ste:col-span-2 ste:sm:col-span-1">
                      <FieldLabel htmlFor="task-block">每批楼层数</FieldLabel>
                      <Input
                        id="task-block"
                        inputMode="numeric"
                        value={range.block}
                        onChange={(event) => {
                          setRange({ ...range, block: event.target.value });
                          setRangeError(null);
                        }}
                      />
                    </Field>
                  </div>
                  {rangeError && (
                    <p role="alert" className="ste:text-xs ste:text-destructive">
                      {rangeError}
                    </p>
                  )}
                  <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2">
                    <p className="ste:text-xs ste:text-muted-foreground">
                      楼层从 0 开始，范围包含起止楼层。
                    </p>
                    <Button type="submit" disabled={state.busy || state.messageCount === 0}>
                      开始填表
                    </Button>
                  </div>
                </form>
              </PageSection>
              <PageSection
                title="本对话配置"
                meta={<span className="ste:text-xs ste:text-muted-foreground">随对话保存</span>}
              >
                <TaskChatConfig
                  rules={currentSettings.cleaningRules}
                  presetSettings={currentSettings.agentPresets}
                  cleaningSelection={state.cleaningSelection}
                  presetOverride={state.agentPresetOverride}
                  autoFillSummary={autoFillSummary}
                  disabled={state.busy}
                  notice={state.configNotice}
                  error={state.configError}
                  onCleaningChange={(ruleId) => workspace.updateCleaningSelection(ruleId)}
                  onPresetChange={(presetId) => workspace.updateAgentPresetOverride(presetId)}
                  onOpenAutoFill={() => requestLeave(onAutoFill)}
                />
              </PageSection>
              <FillList
                title="排队与阻塞"
                items={queued}
                busy={state.busy}
                onOpenLog={onOpenLog}
                onAction={(task, action) => void workspace.fillAction(task.runId, action)}
              />
              {history.length > 0 && (
                <PageSection
                  title="最近结果"
                  meta={
                    <span className="ste:text-xs ste:text-muted-foreground">
                      {history.length} 条
                    </span>
                  }
                  bodyClassName="ste:p-0"
                >
                  <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
                    {visibleHistory.map((task) => (
                      <div role="listitem" key={task.runId} data-fill-task={task.runId}>
                        <FillRow
                          task={task}
                          busy={state.busy}
                          onOpenLog={onOpenLog}
                          onAction={(target, action) =>
                            void workspace.fillAction(target.runId, action)
                          }
                        />
                      </div>
                    ))}
                  </ItemGroup>
                  {history.length > visibleHistory.length && (
                    <div className="ste:border-t ste:border-border ste:p-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ste:w-full"
                        onClick={() => setShowAllHistory(true)}
                      >
                        <ChevronDown data-icon="inline-start" />
                        显示更早的 {history.length - visibleHistory.length} 条
                      </Button>
                    </div>
                  )}
                </PageSection>
              )}
              <Accordion>
                <AccordionItem value="init">
                  <AccordionTrigger>初始化填表</AccordionTrigger>
                  <AccordionContent>
                    <form
                      className="ste:flex ste:flex-col ste:gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void workspace.submitInit();
                      }}
                    >
                      <Field>
                        <FieldLabel htmlFor="task-init">初始化文本</FieldLabel>
                        <Textarea
                          id="task-init"
                          className="ste:min-h-32"
                          placeholder="输入需要写入记忆的背景、设定或摘要"
                          value={state.draft}
                          disabled={state.busy}
                          onChange={(event) => workspace.setDraft(event.target.value)}
                        />
                      </Field>
                      <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2">
                        <p className="ste:text-xs ste:text-muted-foreground">
                          草稿按对话保留；提交后清空。
                        </p>
                        <Button type="submit" disabled={state.busy || !state.draft.trim()}>
                          提交初始化任务
                        </Button>
                      </div>
                    </form>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </TabsContent>
            <TabsContent value="vector" className="ste:space-y-4">
              <VectorList state={state} workspace={workspace} />
            </TabsContent>
          </Tabs>
        )}
      </PageContent>
      {confirmation}
      <ConfirmAction
        open={pendingSubmit !== null}
        onOpenChange={(open) => {
          if (!open) setPendingSubmit(null);
        }}
        title="开始填表任务？"
        description={
          pendingSubmit ? (
            <FillSubmitDescription
              summary={pendingSubmit}
              cleaningLabel={cleaningLabel}
              presetLabel={presetLabel}
              cleaningDisabled={cleaningDisabled}
            />
          ) : null
        }
        cancelLabel="取消"
        confirmLabel="开始填表"
        onConfirm={confirmFill}
      />
    </section>
  );
}

function ProgressSection({
  coverage,
  running,
  last,
  firstUnprocessed,
  busy,
  onUseRange,
  onOpenLog,
  onCancel,
  onRetry,
}: {
  coverage: ReturnType<typeof buildCoverageViewModel>;
  running: FillTaskView | undefined;
  last: FillTaskView | undefined;
  firstUnprocessed: { from: number; to: number } | undefined;
  busy: boolean;
  onUseRange: () => void;
  onOpenLog: (key: string, summary?: string) => void;
  onCancel: (task: FillTaskView) => void;
  onRetry: (task: FillTaskView) => void;
}) {
  return (
    <PageSection
      title="填表进度"
      meta={
        <span className="ste:text-xs ste:text-muted-foreground">
          {coverage.totalCount} 层 · 未处理 {coverage.untrackedCount}
        </span>
      }
    >
      <div className="ste:flex ste:flex-col ste:gap-3">
        {running ? (
          <RunningTask task={running} busy={busy} onOpenLog={onOpenLog} onCancel={onCancel} />
        ) : last ? (
          <LastResult task={last} busy={busy} onOpenLog={onOpenLog} onRetry={onRetry} />
        ) : (
          <p className="ste:text-sm ste:text-muted-foreground">还没有填表任务。</p>
        )}
        <CoverageBar coverage={coverage} />
        {firstUnprocessed && (
          <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2 ste:text-xs">
            <span className="ste:text-muted-foreground">
              未处理楼层 {firstUnprocessed.from}–{firstUnprocessed.to}
            </span>
            <Button variant="outline" size="sm" onClick={onUseRange}>
              按此范围填表
            </Button>
          </div>
        )}
      </div>
    </PageSection>
  );
}

function RunningTask({
  task,
  busy,
  onOpenLog,
  onCancel,
}: {
  task: FillTaskView;
  busy: boolean;
  onOpenLog: (key: string, summary?: string) => void;
  onCancel: (task: FillTaskView) => void;
}) {
  const status = taskStatusViewModel(task);
  return (
    <div className="ste:flex ste:flex-col ste:gap-2 ste:rounded-lg ste:border ste:border-border ste:bg-muted/30 ste:p-3">
      <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2">
        <div className="ste:flex ste:min-w-0 ste:items-center ste:gap-2">
          <Badge variant="secondary">{status.label}</Badge>
          <span className="ste:truncate ste:text-sm ste:font-medium">{taskRangeText(task)}</span>
        </div>
        <div className="ste:flex ste:gap-1">
          <Button
            variant="ghost"
            size="sm"
            data-action="open-task-log"
            data-task-key={task.runId}
            onClick={() => onOpenLog(task.runId, `${taskRangeText(task)} · ${status.label}`)}
          >
            查看日志
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || task.phase === "saving"}
            data-action="cancel-task"
            data-task-key={task.runId}
            onClick={() => onCancel(task)}
          >
            取消任务
          </Button>
        </div>
      </div>
      <TaskProgressBar task={task} />
      {status.detail && (task.kind === "init" || task.retryState || task.phase === "saving") && (
        <p className="ste:text-xs ste:text-muted-foreground">{status.detail}</p>
      )}
      <p className="ste:text-xs ste:text-muted-foreground">
        每批 {task.blockSize} 层 · {task.automatic ? "自动" : "手动"} ·{" "}
        {formatCompactTime(task.createdAt)}
      </p>
      {task.blocksQueue && (
        <p className="ste:text-xs ste:text-destructive">队列已暂停，重试或取消此任务后继续。</p>
      )}
    </div>
  );
}

function LastResult({
  task,
  busy,
  onOpenLog,
  onRetry,
}: {
  task: FillTaskView;
  busy: boolean;
  onOpenLog: (key: string, summary?: string) => void;
  onRetry: (task: FillTaskView) => void;
}) {
  const status = taskStatusViewModel(task);
  return (
    <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2 ste:text-sm">
      <div className="ste:flex ste:min-w-0 ste:flex-wrap ste:items-center ste:gap-2">
        <Badge variant={task.status === "failed" ? "destructive" : "outline"}>{status.label}</Badge>
        <span className="ste:font-medium">{taskRangeText(task)}</span>
        <span className="ste:text-xs ste:text-muted-foreground">
          {formatCompactTime(task.createdAt)}
        </span>
      </div>
      <div className="ste:flex ste:gap-1">
        <Button
          variant="ghost"
          size="sm"
          data-action="open-task-log"
          data-task-key={task.runId}
          onClick={() => onOpenLog(task.runId, `${taskRangeText(task)} · ${status.label}`)}
        >
          查看日志
        </Button>
        {(task.status === "failed" || task.status === "interrupted") && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            data-action="retry-task"
            data-task-key={task.runId}
            onClick={() => onRetry(task)}
          >
            重试
          </Button>
        )}
      </div>
    </div>
  );
}

function FillSubmitDescription({
  summary,
  cleaningLabel,
  presetLabel,
  cleaningDisabled,
}: {
  summary: FillSubmitSummary;
  cleaningLabel: string;
  presetLabel: string;
  cleaningDisabled: boolean;
}) {
  return (
    <div className="ste:flex ste:flex-col ste:gap-2">
      <dl className="ste:grid ste:grid-cols-[auto_minmax(0,1fr)] ste:gap-x-3 ste:gap-y-1 ste:text-sm">
        <dt className="ste:text-muted-foreground">楼层</dt>
        <dd>
          {summary.from}–{summary.to}（{summary.floorCount} 层）
        </dd>
        <dt className="ste:text-muted-foreground">批次</dt>
        <dd>
          每批 {summary.blockSize} 层，共 {summary.batchCount} 批
        </dd>
        <dt className="ste:text-muted-foreground">清洗</dt>
        <dd className="ste:break-words">{cleaningLabel}</dd>
        <dt className="ste:text-muted-foreground">Agent</dt>
        <dd className="ste:break-words">{presetLabel}</dd>
      </dl>
      {(summary.processedCount > 0 ||
        summary.errorCount > 0 ||
        summary.plannedCount > 0 ||
        cleaningDisabled) && (
        <div className="ste:flex ste:flex-col ste:gap-1 ste:text-xs ste:text-destructive">
          {summary.processedCount > 0 && (
            <p>范围内有 {summary.processedCount} 层已处理，重新提交会重新填写。</p>
          )}
          {summary.errorCount > 0 && (
            <p>范围内有 {summary.errorCount} 层出错，重新提交会覆盖错误状态。</p>
          )}
          {summary.plannedCount > 0 && <p>范围内有 {summary.plannedCount} 层已在排队任务中。</p>}
          {cleaningDisabled && <p>所选清洗规则已停用，输入将保持原文。</p>}
        </div>
      )}
    </div>
  );
}

function FillList({
  title,
  items,
  busy,
  onOpenLog,
  onAction,
}: {
  title: string;
  items: readonly FillTaskView[];
  busy: boolean;
  onOpenLog: (key: string, summary?: string) => void;
  onAction: (task: FillTaskView, action: "cancel" | "retry") => void;
}) {
  if (items.length === 0) return null;
  return (
    <PageSection
      title={title}
      meta={<span className="ste:text-xs ste:text-muted-foreground">{items.length} 条</span>}
      bodyClassName="ste:p-0"
    >
      <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
        {items.map((task) => (
          <div role="listitem" key={task.runId} data-fill-task={task.runId}>
            <FillRow task={task} busy={busy} onOpenLog={onOpenLog} onAction={onAction} />
          </div>
        ))}
      </ItemGroup>
    </PageSection>
  );
}

function FillRow({
  task,
  busy,
  onOpenLog,
  onAction,
}: {
  task: FillTaskView;
  busy: boolean;
  onOpenLog: (key: string, summary?: string) => void;
  onAction: (task: FillTaskView, action: "cancel" | "retry") => void;
}) {
  const status = taskStatusViewModel(task);
  const canCancel = task.status === "queued" || task.status === "running" || task.blocksQueue;
  const canRetry = task.status === "failed" || task.status === "interrupted";
  const openLog = () => onOpenLog(task.runId, `${taskRangeText(task)} · ${status.label}`);
  return (
    <Item className="ste:gap-0 ste:rounded-none ste:border-0 ste:p-0 ste:hover:bg-muted/50">
      <div
        role="button"
        tabIndex={0}
        className="ste:flex ste:min-w-0 ste:flex-1 ste:cursor-pointer ste:flex-col ste:gap-1 ste:px-4 ste:py-3 ste:text-left ste:outline-none ste:focus-visible:bg-muted/50 ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:focus-visible:ring-inset"
        aria-label={`查看日志：${taskRangeText(task)}，${status.label}`}
        title="查看任务日志"
        data-action="open-task-log"
        data-task-key={task.runId}
        onClick={openLog}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          openLog();
        }}
      >
        <span className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
          <Badge
            variant={
              task.status === "failed"
                ? "destructive"
                : task.status === "succeeded"
                  ? "outline"
                  : "secondary"
            }
          >
            {status.label}
          </Badge>
          <span className="ste:text-sm ste:font-medium">{taskRangeText(task)}</span>
        </span>
        {status.detail && (
          <span className="ste:break-words ste:text-sm ste:text-muted-foreground">
            {status.detail}
          </span>
        )}
        <span className="ste:text-xs ste:text-muted-foreground">
          {task.automatic ? "自动" : "手动"} · 每批 {task.blockSize} 层 ·{" "}
          {formatCompactTime(task.createdAt)}
        </span>
        {task.blocksQueue && (
          <span className="ste:text-xs ste:text-destructive">
            队列已暂停，重试或取消此任务后继续。
          </span>
        )}
      </div>
      {(canCancel || canRetry) && (
        <ItemActions className="ste:basis-full ste:justify-end ste:gap-1 ste:px-4 ste:pb-3 ste:sm:basis-auto ste:sm:px-3 ste:sm:py-3">
          {canCancel && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || task.phase === "saving"}
              data-action="cancel-task"
              data-task-key={task.runId}
              onClick={() => onAction(task, "cancel")}
            >
              取消任务
            </Button>
          )}
          {canRetry && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-action="retry-task"
              data-task-key={task.runId}
              onClick={() => onAction(task, "retry")}
            >
              重试
            </Button>
          )}
        </ItemActions>
      )}
    </Item>
  );
}

function VectorList({ state, workspace }: { state: TasksSnapshot; workspace: TasksWorkspace }) {
  const selected = state.vectors.filter((task) => state.selected.includes(task.id));
  const cancelIds = selected
    .filter((task) => task.status === "queued" || task.status === "running")
    .map((task) => task.id);
  const retryIds = selected
    .filter((task) => ["failed", "interrupted", "cancelled", "obsolete"].includes(task.status))
    .map((task) => task.id);
  return (
    <PageSection
      title="向量任务"
      meta={
        <span className="ste:text-xs ste:text-muted-foreground">共 {state.vectorTotal} 项</span>
      }
      bodyClassName="ste:p-0"
    >
      <div className="ste:flex ste:flex-col ste:gap-2 ste:border-b ste:border-border ste:p-3">
        <div className="ste:flex ste:flex-wrap ste:gap-2">
          <NativeSelect
            aria-label="向量任务状态"
            value={state.status}
            disabled={state.busy}
            onChange={(event) =>
              workspace.setFilters(event.target.value as TasksSnapshot["status"], state.source)
            }
          >
            <option value="">全部状态</option>
            {Object.entries(vectorLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="向量任务来源"
            value={state.source}
            disabled={state.busy}
            onChange={(event) =>
              workspace.setFilters(state.status, event.target.value as TasksSnapshot["source"])
            }
          >
            <option value="">全部来源</option>
            <option value="manual">手动</option>
            <option value="automatic">自动</option>
          </NativeSelect>
          <span className="ste:flex ste:items-center ste:px-1 ste:text-xs ste:text-muted-foreground">
            已选 {selected.length} 项
          </span>
        </div>
        <div className="ste:flex ste:flex-wrap ste:gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy || !cancelIds.length}
            onClick={() => void workspace.vectorAction(cancelIds, "cancel")}
          >
            取消选中（{cancelIds.length}）
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy || !retryIds.length}
            onClick={() => void workspace.vectorAction(retryIds, "retry")}
          >
            重试选中（{retryIds.length}）
          </Button>
        </div>
      </div>
      {!state.vectors.length ? (
        <div className="ste:p-4">
          <PageEmpty
            title={state.loading ? "正在读取任务…" : "暂无向量任务"}
            description="在表格的向量索引设置中提交构建任务。"
          />
        </div>
      ) : (
        <ItemGroup className="ste:gap-0 ste:divide-y ste:divide-border">
          {state.vectors.map((task) => (
            <div role="listitem" key={task.id} data-vector-task={task.id}>
              <Item className="ste:rounded-none ste:border-0 ste:px-4 ste:py-3">
                <ItemMedia>
                  <Checkbox
                    aria-label={`选择 ${task.recordDisplayText} ${task.groupName}`}
                    checked={state.selected.includes(task.id)}
                    disabled={state.busy}
                    onCheckedChange={(checked) => workspace.select(task.id, checked === true)}
                  />
                </ItemMedia>
                <ItemContent>
                  <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
                    <span className="ste:break-words ste:text-sm ste:font-medium">
                      {task.recordDisplayText}
                    </span>
                    <Badge
                      variant={
                        task.status === "failed"
                          ? "destructive"
                          : task.status === "running"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {vectorLabels[task.status]}
                    </Badge>
                  </div>
                  <p className="ste:text-xs ste:text-muted-foreground">
                    {task.groupName} · {task.source === "manual" ? "手动" : "自动"} ·{" "}
                    {formatCompactTime(task.createdAt)}
                  </p>
                  {task.waitReason && (
                    <p className="ste:break-words ste:text-sm ste:text-muted-foreground">
                      {task.waitReason}
                    </p>
                  )}
                  {task.error && <StatusNotice variant="destructive">{task.error}</StatusNotice>}
                </ItemContent>
                <ItemActions className="ste:basis-full ste:justify-end ste:sm:basis-auto">
                  {task.status === "queued" || task.status === "running" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={state.busy}
                      onClick={() => void workspace.vectorAction([task.id], "cancel")}
                    >
                      取消任务
                    </Button>
                  ) : (
                    task.status !== "succeeded" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={state.busy}
                        onClick={() => void workspace.vectorAction([task.id], "retry")}
                      >
                        重试
                      </Button>
                    )
                  )}
                </ItemActions>
              </Item>
            </div>
          ))}
        </ItemGroup>
      )}
      <div className="ste:flex ste:items-center ste:justify-between ste:gap-2 ste:border-t ste:border-border ste:p-3">
        <Button
          variant="outline"
          size="sm"
          disabled={state.busy || state.vectorPage === 0}
          onClick={() => workspace.setFilters(state.status, state.source, state.vectorPage - 1)}
        >
          上一页
        </Button>
        <span className="ste:text-xs ste:text-muted-foreground">
          第 {state.vectorPage + 1} 页 · 共 {state.vectorTotal} 项
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={state.busy || (state.vectorPage + 1) * 30 >= state.vectorTotal}
          onClick={() => workspace.setFilters(state.status, state.source, state.vectorPage + 1)}
        >
          下一页
        </Button>
      </div>
    </PageSection>
  );
}
