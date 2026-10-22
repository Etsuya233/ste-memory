import {
  effectiveVectorIndexGroups,
  type MemoryFieldRepository,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableRepository,
} from "../memory/index.ts";
import type { VectorIndexService, VectorTarget } from "../vector-index/vector-index-service.ts";
import type {
  RecordVector,
  VectorEmbeddingPort,
  VectorIndexRepository,
  VectorScope,
} from "../vector-index/index.ts";

export interface RetrievalSelection {
  readonly tableId: MemoryTable["id"];
  readonly groupIds: readonly string[];
  /** 指定时只允许这些记录与本组选区配对；省略表示整表。 */
  readonly recordIds?: readonly string[];
}
export interface RetrievalRequest {
  readonly query: string;
  readonly selection: readonly RetrievalSelection[] | null;
  readonly topK: number;
  readonly minimumScore: number | null;
}
export interface RetrievalRange {
  readonly table: MemoryTable;
  readonly groups: readonly { id: string; name: string; error: string | null }[];
  readonly error: string | null;
}
export interface RetrievalCoverage {
  readonly checkedAt: string;
  records: number;
  expected: number;
  ready: number;
  empty: number;
  missing: number;
  stale: number;
  invalid: number;
  readonly issues: string[];
  readonly taskStates: string[];
}
export interface RetrievalGroupHit {
  readonly target: VectorTarget;
  readonly vector: RecordVector;
  readonly score: number;
}
export interface RetrievalHit {
  readonly target: VectorTarget;
  readonly score: number;
  readonly groups: readonly RetrievalGroupHit[];
}
export interface RetrievalResult {
  readonly request: RetrievalRequest;
  readonly ranges: readonly RetrievalSelection[];
  readonly profile: string;
  readonly coverage: RetrievalCoverage;
  readonly hits: readonly RetrievalHit[];
  readonly message: string;
  readonly calls: number;
  readonly timing: { check: number; remote: number; sort: number; total: number };
}
export interface RetrievalState {
  readonly epoch: number;
  readonly dataVersion: number;
  readonly status:
    "idle" | "checking" | "embedding" | "sorting" | "done" | "cancelled" | "stale" | "error";
  readonly result: RetrievalResult | null;
  readonly error: string | null;
  readonly indexUpdated: boolean;
  readonly request: RetrievalRequest | null;
  readonly calls: number;
  readonly startedAt: number | null;
  readonly elapsedMs: number | null;
}

function vectorNorm(values: readonly number[]): number {
  let norm = 0;
  for (const value of values) norm = Math.hypot(norm, value);
  return norm;
}

function validVector(values: readonly number[]): boolean {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every(Number.isFinite) &&
    values.some((value) => value !== 0) &&
    Number.isFinite(vectorNorm(values))
  );
}

/** 查询请求与索引队列独立；只保存页面内状态和一次候选快照。 */
export class VectorRetrievalService {
  private state: RetrievalState = {
    epoch: 0,
    dataVersion: 0,
    status: "idle",
    result: null,
    error: null,
    indexUpdated: false,
    request: null,
    calls: 0,
    startedAt: null,
    elapsedMs: null,
  };
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private generation = 0;
  private context = "";
  private spaceId: MemorySpaceId | null = null;
  private activeKey: string | null = null;
  private activeProfile: string | null = null;
  private selectedRanges: readonly RetrievalSelection[] = [];

  private readonly tables: MemoryTableRepository;
  private readonly fields: MemoryFieldRepository;
  private readonly index: Pick<VectorIndexService, "targets">;
  private readonly repository: VectorIndexRepository;
  private readonly embedding: VectorEmbeddingPort;
  private readonly currentContext: () => string;
  constructor(
    tables: MemoryTableRepository,
    fields: MemoryFieldRepository,
    index: Pick<VectorIndexService, "targets">,
    repository: VectorIndexRepository,
    embedding: VectorEmbeddingPort,
    currentContext: () => string,
  ) {
    this.tables = tables;
    this.fields = fields;
    this.index = index;
    this.repository = repository;
    this.embedding = embedding;
    this.currentContext = currentContext;
  }

  getState = (): RetrievalState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<RetrievalState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  setContext(context: string, spaceId: MemorySpaceId | null, force = false): void {
    if (!force && context === this.context && spaceId === this.spaceId) return;
    this.controller?.abort();
    this.generation++;
    this.activeKey = null;
    this.context = context;
    this.spaceId = spaceId;
    this.selectedRanges = [];
    this.update({
      epoch: this.state.epoch + 1,
      status: "idle",
      result: null,
      error: null,
      indexUpdated: false,
      request: null,
      calls: 0,
      startedAt: null,
      elapsedMs: null,
    });
  }
  cancel(): void {
    this.controller?.abort();
    this.generation++;
    this.activeKey = null;
    this.update({
      elapsedMs: this.state.startedAt === null ? null : Date.now() - this.state.startedAt,
      status: "cancelled",
      error: "搜索已取消；已发送的请求仍可能计费",
    });
  }
  invalidate(spaceId: MemorySpaceId, reason = "资料已变更，请重新搜索"): void {
    if (spaceId !== this.spaceId) return;
    if (this.state.status === "idle") {
      this.update({ dataVersion: this.state.dataVersion + 1 });
      return;
    }
    this.controller?.abort();
    this.generation++;
    this.activeKey = null;
    this.update({
      elapsedMs: this.state.startedAt === null ? null : Date.now() - this.state.startedAt,
      status: "stale",
      dataVersion: this.state.dataVersion + 1,
      error: reason,
    });
  }
  indexChanged(scope: VectorScope & { readonly groupId?: string }, deleted: boolean): void {
    if (
      scope.memorySpaceId !== this.spaceId ||
      !this.selectedRanges.some(
        (range) =>
          (!scope.tableId || range.tableId === scope.tableId) &&
          (!scope.groupId || range.groupIds.includes(scope.groupId)),
      )
    )
      return;
    if (deleted) this.invalidate(scope.memorySpaceId, "所选范围索引已清除或删除，请重新搜索");
    else this.update({ indexUpdated: true });
  }
  profileChanged(): void {
    const profile = this.embedding.getProfile();
    if (
      (this.state.result && this.state.result.profile !== profile?.version) ||
      (this.activeKey && this.activeProfile !== profile?.version)
    ) {
      if (this.spaceId) this.invalidate(this.spaceId, "向量连接已变更，请重新搜索");
    }
  }
  async ranges(spaceId: MemorySpaceId): Promise<RetrievalRange[]> {
    return Promise.all(
      (await this.tables.list(spaceId)).map(async (table) => {
        const fields = await this.fields.list(spaceId, table.id);
        const groups = table.vectorIndex
          ? effectiveVectorIndexGroups(table.vectorIndex, fields).map((group) => ({
              id: group.id,
              name: group.name,
              error:
                group.fieldIds.length === 0
                  ? "分组没有字段"
                  : group.fieldIds.some(
                        (id) => !fields.some((field) => field.id === id && field.enabled),
                      )
                    ? "分组包含不存在或停用的字段"
                    : null,
            }))
          : [];
        return {
          table,
          groups,
          error: !table.enabled
            ? "表已停用"
            : !table.vectorIndex?.enabled
              ? "未开启索引"
              : groups.length === 0
                ? "没有有效分组"
                : null,
        };
      }),
    );
  }

  async search(request: RetrievalRequest): Promise<void> {
    request = { ...request, query: request.query.trim() };
    const key = JSON.stringify(request);
    if (this.activeKey === key) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const context = this.context;
    const spaceId = this.spaceId;
    const started = performance.now();
    const check = () => {
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        context !== this.currentContext()
      )
        throw new DOMException("搜索已失效", "AbortError");
    };
    this.activeKey = key;
    this.update({
      status: "checking",
      result: null,
      error: null,
      indexUpdated: false,
      request,
      calls: 0,
      startedAt: Date.now(),
      elapsedMs: null,
    });
    let remote = 0;
    let checkTime = 0;
    try {
      if (!spaceId) throw new Error("请先绑定有效记忆空间");
      const query = request.query.trim();
      const profile = this.embedding.getProfile();
      if (!profile) throw new Error("请在设置中配置 embedding 连接");
      this.activeProfile = profile.version;
      if (!query) throw new Error("请输入查询文本");
      const limit = Math.min(4000, profile.maxInputChars);
      if (query.length > limit)
        throw new Error(`查询长度 ${query.length} 超过上限 ${limit} 字符，请缩短查询`);
      if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 50)
        throw new Error("Top K 必须是 1–50 的整数");
      if (
        request.minimumScore !== null &&
        (!Number.isFinite(request.minimumScore) ||
          request.minimumScore < -1 ||
          request.minimumScore > 1)
      )
        throw new Error("最低分必须在 [-1, 1] 内");
      const ranges = await this.ranges(spaceId);
      check();
      const selection: readonly RetrievalSelection[] =
        request.selection ??
        ranges
          .filter((range) => !range.error)
          .map((range) => ({
            tableId: range.table.id,
            groupIds: range.groups.map((group) => group.id),
          }));
      if (!selection.length) throw new Error("没有合法搜索范围，请选择已启用索引的表和分组");
      for (const selected of selection) {
        const range = ranges.find((range) => range.table.id === selected.tableId);
        if (!range || range.error || !selected.groupIds.length)
          throw new Error(
            `${range?.table.name ?? selected.tableId}：${range?.error ?? "表或组选区已失效，请修正选择"}`,
          );
        for (const id of selected.groupIds) {
          const group = range.groups.find((group) => group.id === id);
          if (!group || group.error)
            throw new Error(
              `${range.table.name} / ${group?.name ?? id}：${group?.error ?? "分组已删除"}`,
            );
        }
      }
      this.selectedRanges = selection;
      const coverage: RetrievalCoverage = {
        checkedAt: new Date().toISOString(),
        records: 0,
        expected: 0,
        ready: 0,
        empty: 0,
        missing: 0,
        stale: 0,
        invalid: 0,
        issues: [],
        taskStates: [],
      };
      const candidates: { target: VectorTarget; vector: RecordVector }[] = [];
      const records = new Set<string>();
      const checkedTargets = new Set<string>();
      for (const range of selection) {
        if (range.recordIds?.length === 0) continue;
        const selectedRecords = range.recordIds === undefined ? null : new Set(range.recordIds);
        const [targets, vectors] = await Promise.all([
          this.index.targets(
            { memorySpaceId: spaceId, tableId: range.tableId },
            undefined,
            controller.signal,
          ),
          this.repository.listVectors({ memorySpaceId: spaceId, tableId: range.tableId }),
        ]);
        const byTarget = new Map(
          vectors.map((vector) => [JSON.stringify([vector.recordId, vector.groupId]), vector]),
        );
        for (let i = 0; i < targets.length; i++) {
          if (i % 100 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            check();
          }
          const target = targets[i]!;
          if (
            !range.groupIds.includes(target.groupId) ||
            (selectedRecords !== null && !selectedRecords.has(target.record.id))
          )
            continue;
          const targetKey = JSON.stringify([target.table.id, target.record.id, target.groupId]);
          if (checkedTargets.has(targetKey)) continue;
          checkedTargets.add(targetKey);
          records.add(JSON.stringify([target.table.id, target.record.id]));
          if (target.status === "empty") {
            coverage.empty++;
            continue;
          }
          coverage.expected++;
          const label = `${target.table.name} / ${target.record.displayText} / ${target.groupName}`;
          const vector = byTarget.get(JSON.stringify([target.record.id, target.groupId]));
          let reason: string | null = null;
          if (target.status !== "ready") {
            coverage.invalid++;
            reason = target.error ?? "输入异常";
          } else if (!vector) {
            coverage.missing++;
            reason = "缺失";
          } else if (
            vector.fingerprint !== target.fingerprint ||
            vector.model !== profile.model ||
            vector.version !== profile.version
          ) {
            coverage.stale++;
            reason = "过期或 profile 不兼容";
          } else if (
            !validVector(vector.values) ||
            (profile.dimensions !== undefined && vector.values.length !== profile.dimensions)
          ) {
            coverage.invalid++;
            reason = "向量维度或数值异常";
          } else {
            coverage.ready++;
            candidates.push({ target, vector });
          }
          if (reason) coverage.issues.push(`${label}：${reason}`);
        }
      }
      coverage.records = records.size;
      const tasks = await this.repository.listTasks();
      coverage.taskStates.push(
        ...tasks
          .filter(
            (task) =>
              task.memorySpaceId === spaceId &&
              selection.some(
                (range) =>
                  range.tableId === task.tableId &&
                  range.groupIds.includes(task.groupId) &&
                  (range.recordIds === undefined || range.recordIds.includes(task.recordId)),
              ) &&
              ["queued", "running", "failed", "cancelled", "interrupted"].includes(task.status),
          )
          .map(
            (task) =>
              `${task.recordDisplayText} / ${task.groupName}：${task.status}${task.error ? ` · ${task.error}` : ""}`,
          ),
      );
      check();
      checkTime = performance.now() - started;
      const finish = (hits: readonly RetrievalHit[], message: string, sort = 0) => {
        check();
        this.update({
          elapsedMs: performance.now() - started,
          status: "done",
          result: {
            request: { ...request, query },
            ranges: selection,
            profile: profile.version,
            coverage,
            hits,
            message,
            calls: this.state.calls,
            timing: { check: checkTime, remote, sort, total: performance.now() - started },
          },
        });
      };
      if (!candidates.length) {
        finish(
          [],
          !coverage.records
            ? request.selection?.some((range) => range.recordIds !== undefined)
              ? "没有符合筛选条件的记录"
              : "所选表暂无记录"
            : !coverage.expected
              ? "所选记录的分组均无内容"
              : coverage.invalid === coverage.expected
                ? "索引不兼容／异常"
                : "当前范围暂无可检索索引",
        );
        return;
      }
      if (profile.version !== this.embedding.getProfile()?.version)
        throw new Error("向量连接已变更，请重新搜索");
      this.update({ status: "embedding", calls: 1 });
      const remoteStart = performance.now();
      const queryVector = await this.embedding.embed(query, controller.signal);
      remote = performance.now() - remoteStart;
      check();
      if (profile.version !== this.embedding.getProfile()?.version)
        throw new Error("向量连接已变更，请重新搜索");
      if (
        !validVector(queryVector) ||
        (profile.dimensions !== undefined && profile.dimensions !== queryVector.length)
      )
        throw new Error("查询向量维度或数值异常");
      this.update({ status: "sorting" });
      const sortStart = performance.now();
      const grouped = new Map<string, RetrievalGroupHit[]>();
      const queryNorm = vectorNorm(queryVector);
      for (let i = 0; i < candidates.length; i++) {
        if (i % 100 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          check();
        }
        const { target, vector } = candidates[i]!;
        if (vector.values.length !== queryVector.length) {
          coverage.ready--;
          coverage.invalid++;
          coverage.issues.push(
            `${target.table.name} / ${target.record.displayText} / ${target.groupName}：维度 ${vector.values.length} 与查询 ${queryVector.length} 不兼容`,
          );
          continue;
        }
        const norm = vectorNorm(vector.values);
        let score = 0;
        for (let j = 0; j < queryVector.length; j++)
          score += (queryVector[j]! / queryNorm) * (vector.values[j]! / norm);
        score = Math.max(-1, Math.min(1, score));
        const id = JSON.stringify([target.table.id, target.record.id]);
        if (!grouped.has(id)) grouped.set(id, []);
        grouped.get(id)!.push({ target, vector, score });
      }
      const hits = [...grouped.values()]
        .map((groups): RetrievalHit => {
          groups.sort((a, b) => b.score - a.score);
          return { target: groups[0]!.target, score: groups[0]!.score, groups };
        })
        .filter((hit) => request.minimumScore === null || hit.score >= request.minimumScore)
        .sort(
          (a, b) =>
            b.score - a.score ||
            a.target.table.position - b.target.table.position ||
            a.target.table.id.localeCompare(b.target.table.id) ||
            a.target.record.id.localeCompare(b.target.record.id),
        )
        .slice(0, request.topK);
      finish(
        hits,
        !grouped.size
          ? "索引不兼容／异常"
          : !hits.length
            ? "没有达到最低分的记录"
            : coverage.ready < coverage.expected
              ? "部分索引，结果可能遗漏"
              : "搜索完成",
        performance.now() - sortStart,
      );
    } catch (error) {
      if (generation !== this.generation) return;
      if (context !== this.currentContext() || controller.signal.aborted)
        this.update({ status: "stale", error: "搜索已失效，请重新搜索" });
      else
        this.update({
          elapsedMs: performance.now() - started,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (generation === this.generation) {
        this.activeKey = null;
        this.controller = null;
      }
    }
  }
}
