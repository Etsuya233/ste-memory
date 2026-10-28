import { useEffect, useState, useSyncExternalStore } from "react";
import { ListTodo } from "lucide-react";
import { Button } from "../../../ui/primitives/button.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../ui/primitives/tabs.tsx";
import { Card } from "../../../ui/primitives/card.tsx";
import { Badge } from "../../../ui/primitives/badge.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import { Textarea } from "../../../ui/primitives/textarea.tsx";
import { Checkbox } from "../../../ui/primitives/checkbox.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { Field, FieldLabel } from "../../../ui/primitives/field.tsx";
import { PageHeader, PageContent, type PageControls } from "../../components/page-layout.tsx";
import { PageEmpty, PageError, StatusNotice } from "../../components/page-state.tsx";
import { usePageLeave, type RegisterLeaveGuard } from "../../components/confirmation.tsx";
import {
  buildCoverageViewModel,
  taskRangeText,
  taskStatusViewModel,
} from "../../../ui/tasks/task-panel-model.ts";
import type { FillTaskView } from "../../../features/fill-tasks/fill-task.ts";
import type { VectorTaskStatus } from "../../../features/vector-index/types.ts";
import type { TasksWorkspace, TasksSnapshot } from "./tasks-workspace.ts";

const vectorLabels: Record<VectorTaskStatus, string> = {
  queued: "等待中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  obsolete: "已过期",
  cancelled: "已取消",
  interrupted: "已中断",
};
const card = "ste:space-y-3 ste:rounded-xl ste:border ste:border-border ste:p-4";
export function TasksPage({
  workspace,
  controls,
  registerLeaveGuard,
  active = true,
}: {
  workspace: TasksWorkspace;
  controls: PageControls;
  registerLeaveGuard?: RegisterLeaveGuard;
  active?: boolean;
}) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const scope = JSON.stringify([state.context?.chatKey, state.context?.spaceId]);
  const [range, setRange] = useState({ from: "", to: "", block: "20" });
  useEffect(() => (active ? workspace.startPolling() : undefined), [workspace, active]);
  useEffect(() => setRange({ from: "", to: "", block: "20" }), [scope]);
  const { confirmation } = usePageLeave({
    dirty: !!state.draft,
    busy: state.busy,
    scope,
    discard: workspace.discard,
    register: registerLeaveGuard,
  });
  const coverage = buildCoverageViewModel({
    ledger: state.ledger,
    chatLength: state.messageCount,
    activeRange: undefined,
    plannedRanges: state.pending.filter((task) => task.kind === "floor"),
  });
  const running = state.pending.filter((task) => task.status === "running");
  const queued = state.pending.filter((task) => task.status !== "running");
  const history = state.history.filter(
    (task) => !state.pending.some((pending) => pending.runId === task.runId),
  );
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
              <Card size="sm" className="ste:px-4">
                <h2 className="ste:text-sm ste:font-semibold">当前对话覆盖</h2>
                <p className="ste:text-sm ste:text-muted-foreground">
                  共 {coverage.totalCount} 层 · 已处理 {coverage.processedCount} · 任务中{" "}
                  {coverage.runningCount} · 出错 {coverage.errorCount} · 未计划{" "}
                  {coverage.untrackedCount}
                </p>
                <p className="ste:text-xs ste:text-muted-foreground">
                  楼层从 0 开始；填写范围包含起止楼层。已启动的任务交由后台服务执行。
                </p>
              </Card>
              <form
                className={card}
                onSubmit={(event) => {
                  event.preventDefault();
                  void workspace.submitFloors(range.from, range.to, range.block);
                }}
              >
                <h2 className="ste:text-sm ste:font-semibold">按楼层填表</h2>
                <div className="ste:grid ste:grid-cols-2 ste:gap-3">
                  <Field>
                    <FieldLabel htmlFor="task-from">起始楼层</FieldLabel>
                    <Input
                      id="task-from"
                      inputMode="numeric"
                      placeholder="0"
                      value={range.from}
                      onChange={(event) => setRange({ ...range, from: event.target.value })}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="task-to">结束楼层</FieldLabel>
                    <Input
                      id="task-to"
                      inputMode="numeric"
                      placeholder={String(Math.max(0, state.messageCount - 1))}
                      value={range.to}
                      onChange={(event) => setRange({ ...range, to: event.target.value })}
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="task-block">每批楼层数</FieldLabel>
                  <Input
                    id="task-block"
                    inputMode="numeric"
                    value={range.block}
                    onChange={(event) => setRange({ ...range, block: event.target.value })}
                  />
                </Field>
                <Button type="submit" disabled={state.busy || state.messageCount === 0}>
                  提交填表任务
                </Button>
              </form>
              <form
                className={card}
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
                <p className="ste:text-xs ste:text-muted-foreground">
                  草稿按对话保留在本次工作台中，提交后清空。
                </p>
                <Button type="submit" disabled={state.busy || !state.draft.trim()}>
                  提交初始化任务
                </Button>
              </form>
              <FillList title="当前任务" items={running} workspace={workspace} busy={state.busy} />
              <FillList title="排队任务" items={queued} workspace={workspace} busy={state.busy} />
              <FillList
                title="最近历史（最多 100 条）"
                items={history}
                workspace={workspace}
                busy={state.busy}
              />
            </TabsContent>
            <TabsContent value="vector">
              <VectorList state={state} workspace={workspace} />
            </TabsContent>
          </Tabs>
        )}
      </PageContent>
      {confirmation}
    </section>
  );
}
function FillList({
  title,
  items,
  workspace,
  busy,
}: {
  title: string;
  items: readonly FillTaskView[];
  workspace: TasksWorkspace;
  busy: boolean;
}) {
  return (
    <section className="ste:space-y-3">
      <h2 className="ste:text-sm ste:font-semibold">
        {title} · {items.length}
      </h2>
      {items.length === 0 ? (
        <p className="ste:text-sm ste:text-muted-foreground">暂无任务</p>
      ) : (
        items.map((task) => {
          const status = taskStatusViewModel(task);
          return (
            <Card key={task.runId} size="sm" className="ste:px-4">
              <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2">
                <h3 className="ste:text-sm ste:font-medium">{taskRangeText(task)}</h3>
                <Badge variant="secondary">{status.label}</Badge>
              </div>
              <p className="ste:break-words ste:text-sm ste:text-muted-foreground">
                {status.detail}
              </p>
              <p className="ste:text-xs ste:text-muted-foreground">
                {new Date(task.createdAt).toLocaleString()} · {task.automatic ? "自动" : "手动"}
              </p>
              {task.blocksQueue && (
                <StatusNotice>队列已暂停，重试或取消此任务后继续。</StatusNotice>
              )}
              <div className="ste:flex ste:gap-2">
                {(task.status === "queued" || task.status === "running" || task.blocksQueue) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || task.phase === "saving"}
                    onClick={() => void workspace.fillAction(task.runId, "cancel")}
                  >
                    取消任务
                  </Button>
                )}
                {(task.status === "failed" || task.status === "interrupted") && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void workspace.fillAction(task.runId, "retry")}
                  >
                    重试
                  </Button>
                )}
              </div>
            </Card>
          );
        })
      )}
    </section>
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
    <section className="ste:space-y-4">
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
      </div>
      <div className="ste:flex ste:flex-wrap ste:items-center ste:gap-2">
        <span className="ste:text-xs ste:text-muted-foreground">已选 {selected.length} 项</span>
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
      {!state.vectors.length && (
        <PageEmpty
          title={state.loading ? "正在读取任务…" : "暂无向量任务"}
          description="在表格的向量索引设置中提交构建任务。"
        />
      )}
      {state.vectors.map((task) => (
        <Card key={task.id} size="sm" className="ste:px-4">
          <div className="ste:flex ste:items-start ste:gap-3">
            <Checkbox
              aria-label={`选择 ${task.recordDisplayText} ${task.groupName}`}
              checked={state.selected.includes(task.id)}
              disabled={state.busy}
              onCheckedChange={(checked) => workspace.select(task.id, checked === true)}
            />
            <div className="ste:min-w-0 ste:flex-1">
              <h3 className="ste:break-words ste:text-sm ste:font-medium">
                {task.recordDisplayText}
              </h3>
              <p className="ste:text-xs ste:text-muted-foreground">
                {task.groupName} · {task.source === "manual" ? "手动" : "自动"} ·{" "}
                {vectorLabels[task.status]}
              </p>
            </div>
          </div>
          {task.waitReason && (
            <p className="ste:break-words ste:text-sm ste:text-muted-foreground">
              {task.waitReason}
            </p>
          )}
          {task.error && <StatusNotice variant="destructive">{task.error}</StatusNotice>}
          <p className="ste:text-xs ste:text-muted-foreground">
            {new Date(task.createdAt).toLocaleString()}
          </p>
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
        </Card>
      ))}
      <div className="ste:flex ste:items-center ste:justify-between ste:gap-2">
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
    </section>
  );
}
