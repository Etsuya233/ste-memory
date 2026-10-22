import {
  effectiveVectorIndexGroups,
  type MemoryField,
  type MemoryFieldRepository,
  type MemoryRecord,
  type MemoryRecordRepository,
  type MemorySpaceId,
  type MemoryTable,
  type MemoryTableRepository,
  type VectorIndexConfiguration,
} from "../memory/index.ts";
import {
  VectorEmbeddingRequestError,
  type RecordVector,
  type VectorEmbeddingPort,
  type VectorIndexRepository,
  type VectorPreview,
  type VectorScope,
  type VectorSubmissionResult,
  type VectorTask,
  type VectorTaskFilters,
  type VectorTaskPage,
  type VectorTaskSource,
  type VectorTableSummary,
} from "./types.ts";

const active = new Set(["queued", "running"]);
const emptyResult = (): VectorSubmissionResult => ({
  created: 0,
  reused: 0,
  promoted: 0,
  skipped: 0,
});
const vectorId = (space: string, table: string, record: string, group: string): string =>
  [space, table, record, group].join("\u0000");
const suppressionId = (id: string, fingerprint: string): string => `${id}\u0000${fingerprint}`;
const now = (): string => new Date().toISOString();

interface Target {
  readonly table: MemoryTable;
  readonly record: MemoryRecord;
  readonly fields: readonly MemoryField[];
  readonly groupId: string;
  readonly groupName: string;
  readonly input: string;
  readonly fingerprint: string;
  readonly status: VectorPreview["status"];
  readonly error: string | null;
}

export class VectorIndexService {
  private readonly tables: MemoryTableRepository;
  private readonly fields: MemoryFieldRepository;
  private readonly records: MemoryRecordRepository;
  private readonly embedding: VectorEmbeddingPort;
  private readonly repository: VectorIndexRepository;
  private readonly currentSpaceId: () => MemorySpaceId | null;
  private readonly readEnabled: () => boolean;
  private readonly createTaskId: () => string;
  private pumping = false;
  private wakeRequested = false;
  private started = false;
  private readonly controllers = new Map<string, AbortController>();
  private readonly blocked = new Map<string, string>();
  private capacityBlocked: string | null = null;
  private backgroundError: string | null = null;
  private submissionTail: Promise<void> = Promise.resolve();

  constructor(
    tables: MemoryTableRepository,
    fields: MemoryFieldRepository,
    records: MemoryRecordRepository,
    embedding: VectorEmbeddingPort,
    repository: VectorIndexRepository,
    currentSpaceId: () => MemorySpaceId | null,
    readEnabled: () => boolean = () => true,
    createTaskId: () => string = () => crypto.randomUUID(),
  ) {
    this.tables = tables;
    this.fields = fields;
    this.records = records;
    this.embedding = embedding;
    this.repository = repository;
    this.currentSpaceId = currentSpaceId;
    this.readEnabled = readEnabled;
    this.createTaskId = createTaskId;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const task of await this.repository.listTasks()) {
      if (active.has(task.status))
        await this.repository.saveTask({
          ...task,
          status: "interrupted",
          waitReason: null,
          endedAt: now(),
        });
    }
  }

  async submit(
    scope: VectorScope,
    options: { source: VectorTaskSource; force?: boolean; groupId?: string },
  ): Promise<VectorSubmissionResult> {
    return this.changeTasks(() => this.submitInner(scope, options));
  }

  /** 仅串行化本页的任务状态读写；远端请求始终在队列之外等待。 */
  private changeTasks<T>(change: () => Promise<T>): Promise<T> {
    const result = this.submissionTail.then(change);
    this.submissionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async submitInner(
    scope: VectorScope,
    options: { source: VectorTaskSource; force?: boolean; groupId?: string },
  ): Promise<VectorSubmissionResult> {
    await this.start();
    if (!this.readEnabled()) return emptyResult();
    const result = emptyResult();
    const counts = { ...result };
    for (const target of await this.targets(scope)) {
      if (options.groupId && options.groupId !== target.groupId) continue;
      if (
        target.status === "empty" ||
        target.status === "unavailable" ||
        target.status === "configuration_invalid"
      ) {
        counts.skipped++;
        continue;
      }
      const id = vectorId(scope.memorySpaceId, target.table.id, target.record.id, target.groupId);
      const tasks = (await this.repository.listTasks()).filter(
        (task) =>
          vectorId(task.memorySpaceId, task.tableId, task.recordId, task.groupId) === id &&
          task.fingerprint === target.fingerprint &&
          active.has(task.status),
      );
      const running = tasks.find((task) => task.status === "running");
      const queued = tasks.find((task) => task.status === "queued");
      if (options.force && running) {
        const successor = tasks.find((task) => task.predecessorId === running.id);
        if (successor) {
          counts.reused++;
          continue;
        }
        await this.createTask(target, options.source, true, running.id);
        counts.created++;
        continue;
      }
      if (queued) {
        const promoted = options.source === "manual" && queued.source === "automatic";
        await this.repository.saveTask({
          ...queued,
          source: promoted ? "manual" : queued.source,
          force: queued.force || !!options.force,
        });
        if (promoted) counts.promoted++;
        else counts.reused++;
        continue;
      }
      if (running) {
        if (options.source === "manual" && running.source === "automatic") {
          await this.repository.saveTask({ ...running, source: "manual" });
          counts.promoted++;
        } else counts.reused++;
        continue;
      }
      if (options.source === "manual")
        await this.repository.deleteSuppression(suppressionId(id, target.fingerprint));
      if (!options.force) {
        if (
          options.source === "automatic" &&
          (await this.repository.getSuppression(suppressionId(id, target.fingerprint)))
        ) {
          counts.skipped++;
          continue;
        }
        const cached = await this.repository.getVector(id);
        if (cached?.fingerprint === target.fingerprint) {
          counts.skipped++;
          continue;
        }
        const reusable = (
          await this.repository.listVectors({
            memorySpaceId: target.record.memorySpaceId,
            tableId: target.table.id,
            recordId: target.record.id,
          })
        ).find((vector) => vector.fingerprint === target.fingerprint);
        if (reusable) {
          await this.repository.saveVector({ ...reusable, id, groupId: target.groupId });
          counts.skipped++;
          continue;
        }
      }
      await this.repository.deleteSuppression(suppressionId(id, target.fingerprint));
      await this.createTask(target, options.source, !!options.force, null);
      counts.created++;
    }
    this.kick();
    return counts;
  }

  async reconcile(scope: VectorScope): Promise<VectorSubmissionResult> {
    if (!this.readEnabled()) return emptyResult();
    const tasks = await this.repository.listTasks();
    for (const task of tasks.filter(
      (task) => active.has(task.status) && this.inScope(task, scope),
    )) {
      const table = await this.tables.find(task.memorySpaceId, task.tableId);
      if (table && !table.vectorIndex?.enabled) {
        this.controllers.get(task.id)?.abort();
        await this.finish(task, "interrupted", null);
      } else if (!(await this.matches(task))) await this.finish(task, "obsolete", null);
    }
    const targets = await this.targets(scope);
    const available = new Map(
      targets.map((target) => [
        vectorId(target.record.memorySpaceId, target.table.id, target.record.id, target.groupId),
        target,
      ]),
    );
    // 来源切换可替换分组身份；已移除分组的同目标抑制随新身份保留。
    // 仍存在的分组各自独立，不能把取消传播给另一份相同字段配置。
    for (const suppression of await this.repository.listSuppressions()) {
      const [spaceId, tableId, recordId, groupId] = suppression.id.split("\u0000");
      if (
        spaceId !== scope.memorySpaceId ||
        (scope.tableId && tableId !== scope.tableId) ||
        (scope.recordId && recordId !== scope.recordId) ||
        available.has(vectorId(spaceId, tableId!, recordId!, groupId!))
      )
        continue;
      let migrated = false;
      for (const target of targets) {
        if (
          target.table.id !== tableId ||
          target.record.id !== recordId ||
          target.fingerprint !== suppression.fingerprint
        )
          continue;
        const id = suppressionId(
          vectorId(spaceId, tableId!, recordId!, target.groupId),
          target.fingerprint,
        );
        if (!(await this.repository.getSuppression(id)))
          await this.repository.saveSuppression({ ...suppression, id });
        migrated = true;
      }
      if (migrated) await this.repository.deleteSuppression(suppression.id);
    }
    const existingVectors = await this.repository.listVectors(scope);
    for (const target of targets) {
      const id = vectorId(
        target.record.memorySpaceId,
        target.table.id,
        target.record.id,
        target.groupId,
      );
      if (
        existingVectors.some(
          (vector) => vector.id === id && vector.fingerprint === target.fingerprint,
        )
      )
        continue;
      const reusable = existingVectors.find(
        (vector) =>
          vector.memorySpaceId === target.record.memorySpaceId &&
          vector.tableId === target.table.id &&
          vector.recordId === target.record.id &&
          vector.fingerprint === target.fingerprint,
      );
      if (reusable) await this.repository.saveVector({ ...reusable, id, groupId: target.groupId });
    }
    for (const vector of existingVectors) {
      const table = await this.tables.find(vector.memorySpaceId, vector.tableId);
      if (table && !table.vectorIndex?.enabled) continue;
      const target = available.get(vector.id);
      if (!target || target.status === "empty") await this.repository.deleteVector(vector.id);
    }
    let result = emptyResult();
    const tables = scope.tableId
      ? [await this.tables.find(scope.memorySpaceId, scope.tableId)]
      : await this.tables.list(scope.memorySpaceId);
    for (const table of tables) {
      if (!table?.vectorIndex?.enabled || table.vectorIndex.updateMode !== "automatic") continue;
      const next = await this.submit({ ...scope, tableId: table.id }, { source: "automatic" });
      result = {
        created: result.created + next.created,
        reused: result.reused + next.reused,
        promoted: result.promoted + next.promoted,
        skipped: result.skipped + next.skipped,
      };
    }
    this.kick();
    return result;
  }

  async preview(scope: Required<VectorScope>): Promise<VectorPreview[]> {
    return (await this.targets(scope)).map((target) => ({
      groupId: target.groupId,
      groupName: target.groupName,
      input: target.input,
      fingerprint: target.fingerprint,
      status: target.status,
      error: target.error,
    }));
  }

  async previewDraft(
    scope: Required<VectorScope>,
    configuration: VectorIndexConfiguration,
  ): Promise<VectorPreview[]> {
    return (await this.targets(scope, configuration)).map((target) => ({
      groupId: target.groupId,
      groupName: target.groupName,
      input: target.input,
      fingerprint: target.fingerprint,
      status: target.status,
      error: target.error,
    }));
  }

  async previewDraftSummary(
    scope: { memorySpaceId: MemorySpaceId; tableId: MemoryTable["id"] },
    configuration: VectorIndexConfiguration,
  ): Promise<{
    records: number;
    vectors: number;
    ready: number;
    pending: number;
    empty: number;
    invalid: number;
    tooLong: number;
    unavailable: number;
  }> {
    const [records, targets, vectors] = await Promise.all([
      this.records.list(scope.memorySpaceId, scope.tableId),
      this.targets(scope, configuration),
      this.repository.listVectors(scope),
    ]);
    const summary = {
      records: records.length,
      vectors: targets.length,
      ready: 0,
      pending: 0,
      empty: 0,
      invalid: 0,
      tooLong: 0,
      unavailable: 0,
    };
    for (const target of targets) {
      if (target.status === "empty") summary.empty++;
      else if (target.status === "configuration_invalid") summary.invalid++;
      else if (target.status === "too_long") summary.tooLong++;
      else if (target.status === "unavailable") summary.unavailable++;
      else if (
        vectors.some(
          (vector) =>
            vector.recordId === target.record.id && vector.fingerprint === target.fingerprint,
        )
      )
        summary.ready++;
      else summary.pending++;
    }
    return summary;
  }

  async getTableSummary(scope: {
    memorySpaceId: MemorySpaceId;
    tableId: MemoryTable["id"];
  }): Promise<VectorTableSummary> {
    const records = await this.records.list(scope.memorySpaceId, scope.tableId);
    const targets = await this.targets(scope);
    const vectors = await this.repository.listVectors(scope);
    const tasks = (await this.repository.listTasks()).filter((task) => this.inScope(task, scope));
    const byRecord = new Map(
      records.map((record) => [
        record.id,
        targets.filter((target) => target.record.id === record.id),
      ]),
    );
    let ready = 0,
      stale = 0,
      errors = 0,
      empty = 0;
    for (const [recordId, groups] of byRecord) {
      if (groups.length === 0 || groups.every((group) => group.status === "empty")) {
        empty++;
        continue;
      }
      const invalid = groups.some(
        (group) => group.status === "configuration_invalid" || group.status === "too_long",
      );
      const failed = groups.some((group) =>
        tasks.some(
          (task) =>
            task.recordId === recordId &&
            task.groupId === group.groupId &&
            task.fingerprint === group.fingerprint &&
            task.status === "failed",
        ),
      );
      const allReady = groups.every(
        (group) =>
          group.status === "empty" ||
          vectors.some(
            (vector) =>
              vector.recordId === recordId &&
              vector.groupId === group.groupId &&
              vector.fingerprint === group.fingerprint,
          ),
      );
      if (invalid) {
        errors++;
        continue;
      }
      if (allReady) ready++;
      else if (failed) errors++;
      else stale++;
    }
    return {
      records: records.length,
      ready,
      stale,
      errors,
      empty,
      queued: tasks.filter((task) => task.status === "queued").length,
    };
  }

  async getStatus(scope: VectorScope): Promise<{
    vectors: readonly RecordVector[];
    tasks: readonly VectorTask[];
    connection: "ready" | "missing" | "blocked";
    error: string | null;
  }> {
    const profile = this.embedding.getProfile();
    return {
      vectors: await this.repository.listVectors(scope),
      tasks: (await this.repository.listTasks()).filter((task) => this.inScope(task, scope)),
      connection: !profile
        ? "missing"
        : this.blocked.has(profile.version) || this.capacityBlocked
          ? "blocked"
          : "ready",
      error: profile
        ? (this.blocked.get(profile.version) ?? this.capacityBlocked ?? this.backgroundError)
        : "尚未配置向量连接",
    };
  }

  async listTasks(filters: VectorTaskFilters = {}): Promise<VectorTaskPage> {
    const all = await this.repository.listTasks();
    const search = filters.search?.trim().toLocaleLowerCase();
    const firstWaiting = all
      .filter((task) => task.status === "queued")
      .sort(
        (a, b) =>
          Number(b.source === "manual") - Number(a.source === "manual") ||
          Number(b.memorySpaceId === this.currentSpaceId()) -
            Number(a.memorySpaceId === this.currentSpaceId()) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      )[0];
    const items = all
      .filter(
        (task) =>
          (!filters.memorySpaceId || task.memorySpaceId === filters.memorySpaceId) &&
          (!filters.tableId || task.tableId === filters.tableId) &&
          (!filters.statuses || filters.statuses.includes(task.status)) &&
          (!filters.source || task.source === filters.source) &&
          (!search ||
            `${task.recordDisplayText} ${task.groupName}`.toLocaleLowerCase().includes(search)),
      )
      .map((task) =>
        task.status === "queued" && !task.waitReason && firstWaiting && task.id !== firstWaiting.id
          ? {
              ...task,
              waitReason:
                task.source !== firstWaiting.source
                  ? "等待手动优先任务"
                  : task.memorySpaceId !== firstWaiting.memorySpaceId
                    ? "等待当前空间同类任务"
                    : "等待先提交的任务",
            }
          : task,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return {
      items: items.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? 50)),
      total: items.length,
      queued: all.filter((task) => task.status === "queued").length,
      running: all.filter((task) => task.status === "running").length,
      blocked: all.filter(
        (task) =>
          task.status === "queued" &&
          (!this.embedding.getProfile() ||
            this.capacityBlocked !== null ||
            this.blocked.has(task.version)),
      ).length,
    };
  }

  async cancel(id: string): Promise<boolean> {
    const task = await this.repository.getTask(id);
    if (!task || !active.has(task.status)) return false;
    this.controllers.get(id)?.abort();
    await this.finish(task, "cancelled", null);
    await this.repository.saveSuppression({
      id: suppressionId(
        vectorId(task.memorySpaceId, task.tableId, task.recordId, task.groupId),
        task.fingerprint,
      ),
      memorySpaceId: task.memorySpaceId,
      fingerprint: task.fingerprint,
      reason: "cancelled",
    });
    return true;
  }
  async cancelMany(ids: readonly string[]): Promise<number> {
    let count = 0;
    for (const id of ids) if (await this.cancel(id)) count++;
    return count;
  }
  async retry(id: string): Promise<VectorSubmissionResult> {
    const task = await this.repository.getTask(id);
    if (!task || active.has(task.status)) return emptyResult();
    this.blocked.clear();
    this.capacityBlocked = null;
    const targets = await this.targets({
      memorySpaceId: task.memorySpaceId,
      tableId: task.tableId,
      recordId: task.recordId,
    });
    const current = targets.find((target) => target.groupId === task.groupId);
    if (current)
      await this.repository.deleteSuppression(
        suppressionId(
          vectorId(task.memorySpaceId, task.tableId, task.recordId, task.groupId),
          current.fingerprint,
        ),
      );
    return this.submit(
      { memorySpaceId: task.memorySpaceId, tableId: task.tableId, recordId: task.recordId },
      { source: "manual", groupId: task.groupId, force: task.force },
    );
  }

  async clear(scope: VectorScope): Promise<void> {
    return this.changeTasks(() => this.clearInner(scope));
  }
  private async clearInner(scope: VectorScope): Promise<void> {
    for (const task of (await this.repository.listTasks()).filter(
      (task) => active.has(task.status) && this.inScope(task, scope),
    )) {
      this.controllers.get(task.id)?.abort();
    }
    await this.repository.deleteTasks(scope);
    await this.repository.deleteVectors(scope);
    await this.repository.deleteSuppressions(scope);
    for (const target of await this.targets(scope)) {
      const id = vectorId(scope.memorySpaceId, target.table.id, target.record.id, target.groupId);
      await this.repository.saveSuppression({
        id: suppressionId(id, target.fingerprint),
        memorySpaceId: scope.memorySpaceId,
        fingerprint: target.fingerprint,
        reason: "cleared",
      });
    }
  }
  async stop(scope: VectorScope): Promise<void> {
    for (const task of (await this.repository.listTasks()).filter(
      (task) => active.has(task.status) && this.inScope(task, scope),
    )) {
      this.controllers.get(task.id)?.abort();
      await this.finish(task, "interrupted", null);
    }
  }
  async purge(scope: VectorScope): Promise<void> {
    return this.changeTasks(() => this.purgeInner(scope));
  }
  private async purgeInner(scope: VectorScope): Promise<void> {
    for (const task of (await this.repository.listTasks()).filter(
      (task) => active.has(task.status) && this.inScope(task, scope),
    ))
      this.controllers.get(task.id)?.abort();
    await this.repository.deleteTasks(scope);
    await this.repository.deleteVectors(scope);
    await this.repository.deleteSuppressions(scope);
  }
  resumeConnection(): void {
    this.blocked.clear();
    this.capacityBlocked = null;
    this.backgroundError = null;
    this.kick();
  }

  private kick(): void {
    if (this.pumping) {
      this.wakeRequested = true;
      return;
    }
    void this.pump().catch((error) => {
      this.backgroundError = error instanceof Error ? error.message : String(error);
    });
  }

  private inScope(task: VectorTask, scope: VectorScope): boolean {
    return (
      task.memorySpaceId === scope.memorySpaceId &&
      (!scope.tableId || task.tableId === scope.tableId) &&
      (!scope.recordId || task.recordId === scope.recordId)
    );
  }

  private async targets(scope: VectorScope, draft?: VectorIndexConfiguration): Promise<Target[]> {
    const profile = this.embedding.getProfile();
    const tables = scope.tableId
      ? [await this.tables.find(scope.memorySpaceId, scope.tableId)]
      : await this.tables.list(scope.memorySpaceId);
    const targets: Target[] = [];
    for (const table of tables) {
      const configuration = draft ?? table?.vectorIndex;
      if (!table || !configuration || (!draft && !configuration.enabled)) continue;
      const fields = await this.fields.list(scope.memorySpaceId, table.id);
      const records = scope.recordId
        ? [await this.records.find(scope.memorySpaceId, table.id, scope.recordId)]
        : await this.records.list(scope.memorySpaceId, table.id);
      for (const record of records) {
        if (!record) continue;
        for (const group of effectiveVectorIndexGroups(configuration, fields)) {
          const lines: string[] = [];
          let configurationError: string | null = null;
          for (const fieldId of group.fieldIds) {
            const field = fields.find((candidate) => candidate.id === fieldId);
            if (!field?.enabled) {
              configurationError = `向量分组「${group.name}」引用了不存在或停用的字段：${fieldId}`;
              break;
            }
            const value = record.payload[fieldId];
            if (
              value === null ||
              value === undefined ||
              value === "" ||
              (Array.isArray(value) && value.length === 0)
            )
              continue;
            let display: string;
            if (field.type === "single_reference" || field.type === "multi_reference") {
              const ids = Array.isArray(value) ? value : [String(value)];
              const refs = await Promise.all(
                ids.map((id) =>
                  this.records.find(
                    scope.memorySpaceId,
                    field.referenceTableId!,
                    id as MemoryRecord["id"],
                  ),
                ),
              );
              if (refs.some((ref) => ref === undefined)) {
                configurationError = `向量分组「${group.name}」包含已删除的引用记录`;
                break;
              }
              display = refs
                .filter((ref) => ref !== undefined)
                .map((ref) => ref.displayText)
                .join("、");
            } else display = Array.isArray(value) ? value.join("、") : String(value);
            if (display) lines.push(`${field.name}：${display}`);
          }
          const input = lines.join("\n");
          const fingerprint = JSON.stringify([
            group.fieldIds,
            input,
            profile?.model,
            profile?.version,
          ]);
          const status = configurationError
            ? "configuration_invalid"
            : !input
              ? "empty"
              : !profile
                ? "unavailable"
                : input.length > profile.maxInputChars
                  ? "too_long"
                  : "ready";
          targets.push({
            table,
            record,
            fields,
            groupId: group.id,
            groupName: group.name,
            input,
            fingerprint,
            status,
            error:
              configurationError ??
              (status === "too_long"
                ? `输入长度 ${input.length} 超过连接上限 ${profile!.maxInputChars}`
                : status === "unavailable"
                  ? "尚未配置向量连接"
                  : null),
          });
        }
      }
    }
    return targets;
  }

  private async createTask(
    target: Target,
    source: VectorTaskSource,
    force: boolean,
    predecessorId: string | null,
  ): Promise<void> {
    const profile = this.embedding.getProfile();
    if (!profile) return;
    const task: VectorTask = {
      id: this.createTaskId(),
      memorySpaceId: target.record.memorySpaceId,
      tableId: target.table.id,
      recordId: target.record.id,
      recordDisplayText: target.record.displayText,
      groupId: target.groupId,
      groupName: target.groupName,
      fingerprint: target.fingerprint,
      input: target.input,
      model: profile.model,
      version: profile.version,
      dimensions: profile.dimensions ?? 0,
      source,
      force,
      predecessorId,
      status: "queued",
      waitReason: null,
      error: target.error,
      createdAt: now(),
      startedAt: null,
      endedAt: null,
    };
    await this.repository.saveTask(task);
  }

  private async matches(task: VectorTask): Promise<boolean> {
    const targets = await this.targets({
      memorySpaceId: task.memorySpaceId,
      tableId: task.tableId,
      recordId: task.recordId,
    });
    return targets.some(
      (target) =>
        (target.status === "ready" || target.status === "too_long") &&
        target.groupId === task.groupId &&
        target.fingerprint === task.fingerprint,
    );
  }

  private async finish(
    task: VectorTask,
    status: VectorTask["status"],
    error: string | null,
  ): Promise<void> {
    return this.changeTasks(() => this.finishTask(task, status, error));
  }

  private async finishTask(
    task: VectorTask,
    status: VectorTask["status"],
    error: string | null,
  ): Promise<void> {
    const current = await this.repository.getTask(task.id);
    if (!current || !active.has(current.status)) return;
    await this.repository.saveTask({ ...current, status, error, waitReason: null, endedAt: now() });
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.wakeRequested = true;
      return;
    }
    this.pumping = true;
    try {
      while (true) {
        if (!this.readEnabled()) break;
        const profile = this.embedding.getProfile();
        const queued = (await this.repository.listTasks()).filter(
          (task) => task.status === "queued",
        );
        if (!profile || this.capacityBlocked || this.blocked.has(profile.version)) {
          const reason = !profile
            ? "等待向量连接"
            : (this.capacityBlocked ?? this.blocked.get(profile.version)!);
          await this.changeTasks(async () => {
            for (const task of queued) {
              const current = await this.repository.getTask(task.id);
              if (current?.status === "queued")
                await this.repository.saveTask({ ...current, waitReason: reason });
            }
          });
          break;
        }
        const current = this.currentSpaceId();
        queued.sort(
          (a, b) =>
            Number(b.source === "manual") - Number(a.source === "manual") ||
            Number(b.memorySpaceId === current) - Number(a.memorySpaceId === current) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
        const candidate = queued.find(
          (candidate) =>
            !candidate.predecessorId ||
            !queued.some((other) => other.id === candidate.predecessorId),
        );
        if (!candidate) break;
        if (!(await this.matches(candidate))) {
          await this.finish(candidate, "obsolete", null);
          continue;
        }
        const controller = new AbortController();
        const task = await this.changeTasks(async () => {
          const currentTask = await this.repository.getTask(candidate.id);
          if (currentTask?.status !== "queued" || !this.readEnabled()) return null;
          if (currentTask.error) return currentTask;
          this.controllers.set(currentTask.id, controller);
          const running: VectorTask = {
            ...currentTask,
            status: "running",
            waitReason: null,
            startedAt: now(),
          };
          await this.repository.saveTask(running);
          return running;
        });
        if (!task) continue;
        if (task.error) {
          await this.finish(task, "failed", task.error);
          await this.repository.saveSuppression({
            id: suppressionId(
              vectorId(task.memorySpaceId, task.tableId, task.recordId, task.groupId),
              task.fingerprint,
            ),
            memorySpaceId: task.memorySpaceId,
            fingerprint: task.fingerprint,
            reason: "failed",
          });
          continue;
        }
        try {
          const values = await this.embedding.embed(task.input, controller.signal);
          await this.changeTasks(async () => {
            const currentTask = await this.repository.getTask(task.id);
            if (!currentTask || currentTask.status !== "running") return;
            if (!(await this.matches(task))) {
              await this.finishTask(task, "obsolete", null);
              return;
            }
            if (controller.signal.aborted) return;
            if (
              values.length === 0 ||
              values.some((value) => !Number.isFinite(value)) ||
              (task.dimensions > 0 && values.length !== task.dimensions)
            )
              throw new Error("向量响应维度或数值无效");
            await this.repository.saveVector({
              id: vectorId(task.memorySpaceId, task.tableId, task.recordId, task.groupId),
              memorySpaceId: task.memorySpaceId,
              tableId: task.tableId,
              recordId: task.recordId,
              groupId: task.groupId,
              fingerprint: task.fingerprint,
              values,
              model: task.model,
              version: task.version,
              updatedAt: now(),
            });
            await this.finishTask(task, "succeeded", null);
            await this.repository.deleteSuppression(
              suppressionId(
                vectorId(task.memorySpaceId, task.tableId, task.recordId, task.groupId),
                task.fingerprint,
              ),
            );
          });
        } catch (error) {
          const currentTask = await this.repository.getTask(task.id);
          if (!currentTask || currentTask.status !== "running") continue;
          const message = error instanceof Error ? error.message : String(error);
          await this.finish(task, "failed", message);
          await this.repository.saveSuppression({
            id: suppressionId(
              vectorId(task.memorySpaceId, task.tableId, task.recordId, task.groupId),
              task.fingerprint,
            ),
            memorySpaceId: task.memorySpaceId,
            fingerprint: task.fingerprint,
            reason: "failed",
          });
          if (error instanceof VectorEmbeddingRequestError && error.global) {
            if (error.category === "capacity") this.capacityBlocked = message;
            else this.blocked.set(profile.version, message);
          }
          if (/QuotaExceededError|存储容量/i.test(message)) this.capacityBlocked = message;
        } finally {
          this.controllers.delete(task.id);
        }
      }
    } finally {
      this.pumping = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        this.kick();
      }
    }
  }
}
