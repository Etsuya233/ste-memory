import type { FillTaskService } from "../../../features/fill-tasks/fill-task-service.ts";
import type { FillTaskView, FloorLedgerEntry } from "../../../features/fill-tasks/fill-task.ts";
import type { VectorIndexService } from "../../../features/vector-index/vector-index-service.ts";
import type {
  VectorTask,
  VectorTaskStatus,
  VectorTaskSource,
} from "../../../features/vector-index/types.ts";
import { validateFloorRange, validateBlockSize } from "../../../ui/tasks/task-panel-model.ts";
import type { RecordsContext } from "../records-workspace.ts";

export interface TasksServices {
  tasks: Pick<
    FillTaskService,
    "pendingTasks" | "recentTasks" | "ledgerStatuses" | "submit" | "submitInit" | "cancel" | "retry"
  >;
  vector: Pick<VectorIndexService, "listTasks" | "cancel" | "cancelMany" | "retry">;
  messageCount: () => number;
  assertContext: (context: RecordsContext) => void;
}
export interface TasksSnapshot {
  context: RecordsContext | null;
  pending: readonly FillTaskView[];
  history: readonly FillTaskView[];
  ledger: readonly FloorLedgerEntry[];
  messageCount: number;
  vectors: readonly VectorTask[];
  vectorTotal: number;
  vectorPage: number;
  status: VectorTaskStatus | "";
  source: VectorTaskSource | "";
  selected: readonly string[];
  draft: string;
  busy: boolean;
  loading: boolean;
  error: string | null;
  loadError: string | null;
  notice: string | null;
}
const empty = (): TasksSnapshot => ({
  context: null,
  pending: [],
  history: [],
  ledger: [],
  messageCount: 0,
  vectors: [],
  vectorTotal: 0,
  vectorPage: 0,
  status: "",
  source: "",
  selected: [],
  draft: "",
  busy: false,
  loading: false,
  error: null,
  loadError: null,
  notice: null,
});

export class TasksWorkspace {
  private state = empty();
  private listeners = new Set<() => void>();
  private drafts = new Map<string, string>();
  private pendingOperations = new Set<string>();
  private generation = 0;
  private pollVersion = 0;
  private reading: Promise<void> | null = null;
  private requested = false;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly services: TasksServices;
  constructor(services: TasksServices) {
    this.services = services;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  hasUnsavedChanges = () => this.state.draft.length > 0 || [...this.drafts.values()].some(Boolean);
  private publish(patch: Partial<TasksSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  setContext(context: RecordsContext | null) {
    if (
      context?.chatKey === this.state.context?.chatKey &&
      context?.spaceId === this.state.context?.spaceId
    ) {
      this.publish({ context });
      return;
    }
    this.generation++;
    this.state = {
      ...empty(),
      context,
      busy: context
        ? this.pendingOperations.has(JSON.stringify([context.chatKey, context.spaceId]))
        : false,
      draft: context
        ? (this.drafts.get(JSON.stringify([context.chatKey, context.spaceId])) ?? "")
        : "",
    };
    this.publish({});
    if (this.active && !document.hidden) void this.refresh();
  }
  setDraft = (draft: string) => {
    const context = this.state.context;
    if (!context) throw new Error("请先打开对话");
    this.drafts.set(JSON.stringify([context.chatKey, context.spaceId]), draft);
    this.publish({ draft });
  };
  discard = () => this.setDraft("");
  startPolling = () => {
    this.active = true;
    let pollToken = ++this.pollVersion;
    const tick = async () => {
      const tickToken = pollToken;
      if (!this.active || document.hidden) return;
      await this.refresh();
      if (tickToken === this.pollVersion && this.active && !document.hidden)
        this.timer = setTimeout(() => void tick(), 1000);
    };
    const visibility = () => {
      clearTimeout(this.timer);
      pollToken = ++this.pollVersion;
      this.generation++;
      this.requested = false;
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", visibility);
    void tick();
    return () => {
      this.active = false;
      this.pollVersion++;
      this.generation++;
      this.requested = false;
      clearTimeout(this.timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  };
  refresh = (): Promise<void> => {
    this.requested = true;
    if (this.reading) return this.reading;
    this.reading = this.readLoop().finally(() => {
      this.reading = null;
    });
    return this.reading;
  };
  private async readLoop() {
    while (this.requested) {
      this.requested = false;
      const { context, status, source, vectorPage } = this.state;
      if (!context) return;
      const token = this.generation;
      this.publish({ loading: true });
      try {
        this.services.assertContext(context);
        const messageCount = this.services.messageCount();
        const results = await Promise.allSettled([
          this.services.tasks.pendingTasks(context.spaceId),
          this.services.tasks.recentTasks(context.spaceId, 100),
          messageCount
            ? this.services.tasks.ledgerStatuses(context.spaceId, 0, messageCount - 1)
            : Promise.resolve([]),
          this.services.vector.listTasks({
            memorySpaceId: context.spaceId,
            statuses: status ? [status] : undefined,
            source: source || undefined,
            offset: vectorPage * 30,
            limit: 30,
          }),
        ]);
        const [pendingResult, historyResult, ledgerResult, vectorsResult] = results;
        if (pendingResult.status === "rejected") throw pendingResult.reason;
        if (historyResult.status === "rejected") throw historyResult.reason;
        if (ledgerResult.status === "rejected") throw ledgerResult.reason;
        if (vectorsResult.status === "rejected") throw vectorsResult.reason;
        const pending = pendingResult.value;
        const history = historyResult.value;
        const ledger = ledgerResult.value;
        const vectors = vectorsResult.value;
        if (token === this.generation)
          this.publish({
            pending,
            history,
            ledger,
            messageCount,
            vectors: vectors.items,
            vectorTotal: vectors.total,
            selected: this.state.selected.filter((id) => vectors.items.some((t) => t.id === id)),
            loading: false,
            loadError: null,
          });
      } catch (error) {
        if (token === this.generation)
          this.publish({
            loading: false,
            loadError: error instanceof Error ? error.message : String(error),
          });
      }
    }
  }
  setFilters = (
    status: TasksSnapshot["status"],
    source: TasksSnapshot["source"],
    vectorPage = 0,
  ) => {
    this.generation++;
    this.publish({ status, source, vectorPage, selected: [] });
    void this.refresh();
  };
  select = (id: string, checked: boolean) =>
    this.publish({
      selected: checked
        ? [...new Set([...this.state.selected, id])]
        : this.state.selected.filter((value) => value !== id),
    });
  async perform(action: (context: RecordsContext) => Promise<unknown>, notice: string) {
    const context = this.state.context;
    if (!context) return;
    const key = JSON.stringify([context.chatKey, context.spaceId]);
    if (this.pendingOperations.has(key)) return;
    this.pendingOperations.add(key);
    this.publish({ busy: true, error: null, notice: null });
    let result: Partial<TasksSnapshot>;
    try {
      this.services.assertContext(context);
      await action(context);
      result = { notice };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.pendingOperations.delete(key);
    }
    if (
      this.state.context?.chatKey === context.chatKey &&
      this.state.context.spaceId === context.spaceId
    ) {
      this.publish({ ...result, busy: false });
      if (this.active && !document.hidden) void this.refresh();
    }
  }
  submitFloors = (from: string, to: string, block: string) =>
    this.perform(async (context) => {
      const range = validateFloorRange(from, to, this.services.messageCount());
      const size = validateBlockSize(block);
      if (range.kind === "error") throw new Error(range.message);
      if (size.kind === "error") throw new Error(size.message);
      await this.services.tasks.submit({
        memorySpaceId: context.spaceId,
        from: range.from,
        to: range.to,
        blockSize: size.value,
      });
    }, "填表任务已加入队列");
  submitInit = () => {
    const text = this.state.draft;
    return this.perform(async (context) => {
      if (!text.trim()) throw new Error("请输入初始化文本");
      await this.services.tasks.submitInit({ memorySpaceId: context.spaceId, text });
      const key = JSON.stringify([context.chatKey, context.spaceId]);
      if (this.drafts.get(key) === text) {
        this.drafts.delete(key);
        if (
          this.state.context?.chatKey === context.chatKey &&
          this.state.context.spaceId === context.spaceId
        )
          this.publish({ draft: "" });
      }
    }, "初始化任务已加入队列");
  };
  fillAction = (id: string, action: "cancel" | "retry") =>
    this.perform(
      (context) => this.services.tasks[action](context.spaceId, id),
      action === "cancel" ? "任务已取消" : "任务已重新提交",
    );
  vectorAction = (ids: readonly string[], action: "cancel" | "retry") =>
    this.perform(
      async (context) => {
        if (
          ids.some(
            (id) =>
              !this.state.vectors.some(
                (task) => task.id === id && task.memorySpaceId === context.spaceId,
              ),
          )
        )
          throw new Error("任务列表已变化，请重新选择");
        if (action === "cancel") await this.services.vector.cancelMany(ids);
        else
          for (const id of ids) {
            this.services.assertContext(context);
            await this.services.vector.retry(id);
          }
      },
      action === "cancel" ? "已处理取消请求" : "已处理重试请求",
    );
}
