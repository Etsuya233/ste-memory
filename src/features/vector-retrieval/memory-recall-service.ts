import type { MemorySpaceId, MemorySpaceReader } from "../memory/index.ts";
import { buildMemorySpaceTableDigest } from "../agent/index.ts";
import type { MemoryView } from "../macros/memory-views.ts";
import { planMemoryViewQuery } from "../macros/memory-view-query.ts";
import { sanitizeMacroSyntax } from "../macros/memory-view-render.ts";
import type {
  RetrievalHit,
  RetrievalSelection,
  VectorRetrievalService,
} from "./vector-retrieval-service.ts";

export interface RecallBinding {
  readonly scope: "global" | "chat";
  readonly name: string;
  readonly tableKey: string;
  readonly groupIds: readonly string[];
}
export interface RecallConfiguration {
  readonly enabled: boolean;
  readonly spaceId: MemorySpaceId | null;
  readonly bindings: readonly RecallBinding[];
  readonly topK: number;
  readonly minimumScore: number | null;
  readonly maxChars: number;
}
export const DEFAULT_RECALL_CONFIGURATION: RecallConfiguration = {
  enabled: false,
  spaceId: null,
  bindings: [],
  topK: 10,
  minimumScore: null,
  maxChars: 4000,
};
export interface RecallState {
  readonly configuration: RecallConfiguration;
  readonly status: "idle" | "preparing" | "done" | "skipped" | "stale";
  readonly message: string;
  readonly query: string;
  readonly text: string;
  readonly outputCount: number;
  readonly ranges: readonly (RecallBinding & {
    matched: number;
    condition: MemoryView["condition"];
  })[];
  readonly elapsedMs: number;
}
interface RecallPorts {
  readonly retrieval: VectorRetrievalService;
  readonly reader: MemorySpaceReader;
  readonly context: () => string;
  readonly spaceId: () => MemorySpaceId | null;
  readonly readConfiguration: () => RecallConfiguration;
  readonly writeConfiguration: (value: RecallConfiguration) => void;
  readonly views: (scope: RecallBinding["scope"]) => readonly MemoryView[];
  readonly enabled: () => boolean;
  readonly source: (floor: number) => { content: string; isUser: boolean } | undefined;
  readonly lastUser: () => number;
  readonly isGroup: () => boolean;
  readonly stopGeneration: () => void;
}

export function renderRecall(
  hits: readonly RetrievalHit[],
  maxChars: number,
): { text: string; count: number; message: string } {
  let text = "";
  let count = 0;
  for (const hit of hits) {
    const header = sanitizeMacroSyntax(
      `【${hit.target.table.name} / ${hit.target.table.key} · ${hit.target.record.id} · ${hit.target.groupName}】\n`,
    );
    const body = sanitizeMacroSyntax(hit.target.input);
    const separator = text ? "\n\n" : "";
    if (text.length + separator.length + header.length + body.length > maxChars) {
      if (count) break;
      const marker = "\n[正文已截断]";
      const available = maxChars - header.length - marker.length;
      if (available <= 0) return { text: "", count: 0, message: "输出预算不足，无法保留来源" };
      text = header + body.slice(0, available) + marker;
      count = 1;
      break;
    }
    text += separator + header + body;
    count++;
  }
  return { text, count, message: "" };
}

/** 一个当前用户轮次的页面快照；等待与手动搜索、索引队列相互独立。 */
export class MemoryRecallService {
  private state: RecallState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private startedAt: number | null = null;
  private release: (() => void) | null = null;
  private armed = false;
  private suppressed = false;
  private normalBuilding = false;
  private group = false;
  private sourceFloor = -1;
  private sourceText = "";
  private snapshotContext = "";
  private viewsFingerprint = "";
  private readonly ports: RecallPorts;
  constructor(ports: RecallPorts) {
    this.ports = ports;
    this.state = {
      configuration: ports.readConfiguration(),
      status: "idle",
      message: "尚未召回",
      query: "",
      text: "",
      outputCount: 0,
      ranges: [],
      elapsedMs: 0,
    };
    let dataVersion = ports.retrieval.getState().dataVersion;
    ports.retrieval.subscribe(() => {
      const retrieval = ports.retrieval.getState();
      const changed = dataVersion !== retrieval.dataVersion;
      dataVersion = retrieval.dataVersion;
      if (
        retrieval.status === "stale" ||
        (changed && (this.state.status === "preparing" || this.state.status === "done"))
      )
        this.invalidate("记忆资料或索引已变更");
    });
  }
  getState = (): RecallState => this.state;
  getRetrieval = (): VectorRetrievalService => this.ports.retrieval;
  sourceChanged(): void {
    if (
      this.sourceFloor !== this.ports.lastUser() ||
      this.sourceText !== this.ports.source(this.sourceFloor)?.content
    )
      this.invalidate("查询消息已编辑或删除");
  }
  generationFinished(dryRun = false): void {
    this.suppressed = false;
    if (!dryRun) this.normalBuilding = false;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Partial<RecallState>): void {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  async choices() {
    const id = this.ports.spaceId();
    const ranges = id ? await this.ports.retrieval.ranges(id) : [];
    return (["global", "chat"] as const).flatMap((scope) =>
      this.ports.views(scope).map((view) => ({
        scope,
        view,
        range: ranges.find((range) => range.table.key === view.tableKey),
      })),
    );
  }
  saveConfiguration(value: RecallConfiguration): void {
    if (!Number.isInteger(value.topK) || value.topK < 1 || value.topK > 50)
      throw new Error("Top K 必须是 1–50 的整数");
    if (!Number.isInteger(value.maxChars) || value.maxChars < 500)
      throw new Error("输出字符上限至少为 500");
    if (
      value.minimumScore !== null &&
      (!Number.isFinite(value.minimumScore) || value.minimumScore < -1 || value.minimumScore > 1)
    )
      throw new Error("最低分必须在 [-1, 1] 内");
    if (
      value.enabled &&
      (!value.bindings.length || value.bindings.some((binding) => !binding.groupIds.length))
    )
      throw new Error("启用前请选择命名视图及向量组");
    this.invalidate("召回配置已修改");
    this.ports.writeConfiguration(value);
    this.update({ configuration: value });
  }
  syncContext(): void {
    this.invalidate("对话或绑定空间已切换");
    let configuration = this.ports.readConfiguration();
    if (configuration.spaceId !== this.ports.spaceId()) {
      configuration = {
        ...configuration,
        enabled: false,
        spaceId: this.ports.spaceId(),
        bindings: [],
      };
      this.ports.writeConfiguration(configuration);
    }
    this.update({ configuration, query: "", ranges: [], status: "idle" });
  }
  chatChanged(): void {
    if (this.release) this.ports.stopGeneration();
    this.group = false;
    this.normalBuilding = false;
    this.armed = false;
    this.invalidate("对话已切换");
  }
  invalidate(message: string): void {
    this.generation++;
    if (this.release && this.startedAt !== null)
      this.update({ elapsedMs: Date.now() - this.startedAt });
    this.release?.();
    this.release = null;
    if (["checking", "embedding", "sorting"].includes(this.ports.retrieval.getState().status))
      this.ports.retrieval.cancel();
    this.update({ text: "", outputCount: 0, status: "stale", message });
  }
  skip = (): void => {
    this.invalidate("已跳过本次召回，继续生成");
    this.update({ status: "skipped" });
  };
  stop(): void {
    this.normalBuilding = false;
    this.armed = false;
    this.invalidate("ST 已停止生成");
  }
  groupStarted(): void {
    this.group = true;
    this.armed = false;
  }
  groupEnded(): void {
    this.group = false;
    this.armed = false;
  }
  started(
    type: unknown,
    options: { automatic_trigger?: boolean; signal?: AbortSignal; continuation?: boolean },
    dryRun: boolean,
  ): void {
    if (dryRun || type === "quiet" || type === "impersonate") {
      // 宿主宏回调没有生成归属。并发 token 预估让正在构建的真实提示词优先。
      this.suppressed = !this.normalBuilding;
      return;
    }
    this.normalBuilding = true;
    this.suppressed = false;
    if (options.continuation) {
      this.armed = false;
      return;
    }
    if (
      this.group &&
      this.sourceFloor === this.ports.lastUser() &&
      this.snapshotContext === this.ports.context()
    )
      return;
    if (type === "regenerate" || type === "swipe" || type === "continue") {
      this.armed = false;
      return;
    }
    this.invalidate("等待本轮用户消息");
    this.sourceFloor = -1;
    this.armed =
      (!this.ports.isGroup() || this.group) &&
      !options.automatic_trigger &&
      (type === undefined || type === "normal");
  }
  getMacroText = (): string => {
    if (this.suppressed || !this.ports.enabled() || !this.state.configuration.enabled) return "";
    if (this.snapshotContext !== this.ports.context() || this.sourceFloor !== this.ports.lastUser())
      return "";
    if (
      this.sourceText !== this.ports.source(this.sourceFloor)?.content ||
      this.viewsFingerprint !== this.fingerprint()
    ) {
      this.invalidate("查询消息或命名视图已变更");
      return "";
    }
    return this.state.text;
  };
  private fingerprint(): string {
    return JSON.stringify([this.ports.views("global"), this.ports.views("chat")]);
  }
  async messageSent(floor: number): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    // ST 的后台 token dry run 可以插入真实发送；已保存用户消息确认真实轮次。
    this.suppressed = false;
    const source = this.ports.source(floor);
    if (!source?.isUser || !this.ports.enabled() || !this.state.configuration.enabled) return;
    const generation = ++this.generation;
    const context = this.ports.context();
    this.sourceFloor = floor;
    this.sourceText = source.content;
    this.snapshotContext = context;
    this.viewsFingerprint = this.fingerprint();
    const started = Date.now();
    this.startedAt = started;
    this.update({
      status: "preparing",
      text: "",
      query: source.content.trim(),
      ranges: [],
      elapsedMs: 0,
      message: "准备召回",
      outputCount: 0,
    });
    let timer: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<void>((resolve) => {
      this.release = resolve;
      timer = setTimeout(() => {
        this.skip();
        this.update({ message: "召回超过 10 秒，已跳过" });
      }, 10_000);
    });
    const check = () => {
      if (generation !== this.generation || context !== this.ports.context())
        throw new DOMException("召回已失效", "AbortError");
    };
    const work = async () => {
      try {
        const configuration = this.state.configuration;
        const id = this.ports.spaceId();
        if (!id || configuration.spaceId !== id)
          throw new Error("请先绑定有效记忆空间并重新配置召回");
        const digest = await buildMemorySpaceTableDigest(this.ports.reader, id);
        check();
        const selection: RetrievalSelection[] = [];
        const actual: RecallState["ranges"][number][] = [];
        if (!configuration.bindings.length) throw new Error("请选择命名视图");
        for (const binding of configuration.bindings) {
          const view = this.ports.views(binding.scope).find((view) => view.name === binding.name);
          if (!view || view.tableKey !== binding.tableKey)
            throw new Error(`视图 ${binding.scope}/${binding.name} 已失效，请重新选择`);
          const plan = planMemoryViewQuery({ ...view, projection: [], limit: null }, digest);
          if (!plan) throw new Error(`视图 ${binding.name} 的表或条件已失效`);
          const recordIds: string[] = [];
          for (let page = 1; ; page++) {
            const result = await this.ports.reader.queryRecords(id, {
              ...plan.query,
              paging: { page, pageSize: 100 },
            });
            check();
            recordIds.push(...result.records.map((record) => record.id));
            if (page >= result.totalPages) break;
          }
          selection.push({ tableId: plan.table.id, groupIds: binding.groupIds, recordIds });
          actual.push({ ...binding, matched: recordIds.length, condition: view.condition });
        }
        this.update({ ranges: actual });
        await this.ports.retrieval.search({
          query: source.content.trim(),
          selection,
          topK: configuration.topK,
          minimumScore: configuration.minimumScore,
        });
        check();
        const result = this.ports.retrieval.getState();
        if (result.status !== "done" || !result.result)
          throw new Error(result.error ?? "召回已取消");
        check();
        if (
          this.viewsFingerprint !== this.fingerprint() ||
          this.sourceText !== this.ports.source(floor)?.content
        )
          throw new Error("查询消息或命名视图已变更");
        const output = renderRecall(result.result.hits, configuration.maxChars);
        this.update({
          status: "done",
          text: output.text,
          outputCount: output.count,
          message: output.message || result.result.message,
        });
      } catch (error) {
        if (generation === this.generation)
          this.update({
            status: "skipped",
            text: "",
            message: error instanceof Error ? error.message : String(error),
          });
      }
    };
    await Promise.race([work(), interrupted]);
    clearTimeout(timer!);
    if (generation === this.generation) {
      this.release = null;
      this.update({ elapsedMs: Date.now() - started });
    }
  }
}
