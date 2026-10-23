import type { FillTaskView, FloorLedgerEntry } from "../../src/features/fill-tasks/fill-task.ts";
import type { VectorTask, VectorTaskFilters } from "../../src/features/vector-index/types.ts";

/** 可变内存任务；不调用服务、不产生网络请求。 */
export function installTaskPreview(runtime: any, now: string) {
  let fill: FillTaskView[] = ["failed", "succeeded", "interrupted"].map((status, index) => ({
    runId: `fill-history-${index}`, memorySpaceId: "space-1", kind: "floor", initText: null,
    from: index * 3, to: index * 3 + 2, blockSize: 20, chatId: "preview-chat", status,
    processedCount: status === "succeeded" ? 3 : 1, totalCount: 3,
    errorMessage: status === "failed" ? "连接暂时不可用，请检查连接设置后重试。" : null,
    createdAt: now, updatedAt: now,
  })) as FillTaskView[];
  let ledger: FloorLedgerEntry[] = Array.from({ length: 9 }, (_, floor) => ({ floor, status: floor === 8 ? "error" : "processed" }));
  let vectors: VectorTask[] = Array.from({ length: 42 }, (_, index) => ({
    id: `vector-task-${index}`, memorySpaceId: index < 38 ? "space-1" : "space-other",
    tableId: index % 2 ? "table-events" : "table-people", recordId: `record-${index}`,
    recordDisplayText: index % 2 ? `旧港旅途中的约定 ${index}` : `林澈与白塔守望者的经历 ${index}`,
    groupId: "automatic", groupName: "全部启用字段", fingerprint: `preview-fingerprint-${index}`,
    input: "雨夜旧港的约定与白塔线索。\n".repeat(12), model: "local-preview", version: "v1", dimensions: 128,
    source: index % 2 ? "automatic" : "manual", force: false, predecessorId: null,
    status: index === 0 ? "running" : index < 34 ? "queued" : ["failed", "succeeded", "cancelled", "interrupted", "obsolete"][index % 5],
    waitReason: index === 2 ? "等待前序任务完成" : null,
    error: index === 35 ? "连接超时，检查连接后可重试。" : null,
    createdAt: now, startedAt: index === 0 ? now : null, endedAt: index >= 34 ? now : null,
  })) as VectorTask[];
  const ensureIdle = () => { if (fill.some(task => task.status === "running")) throw new Error("已有活动任务"); };
  runtime.tasks = {
    activeTask: async (spaceId: string) => fill.find(task => task.memorySpaceId === spaceId && task.status === "running"),
    recentTasks: async (spaceId: string, limit: number) => fill.filter(task => task.memorySpaceId === spaceId).slice(0, limit),
    ledgerStatuses: async (_space: string, from: number, to: number) => ledger.filter(item => item.floor >= from && item.floor <= to),
    submit: async (input: any) => {
      ensureIdle();
      const task = { ...fill[0], ...input, runId: crypto.randomUUID(), kind: "floor", initText: null, status: "running", errorMessage: null, processedCount: 0, totalCount: input.to - input.from + 1 } as FillTaskView;
      fill = [task, ...fill]; return task;
    },
    submitInit: async (input: any) => {
      ensureIdle();
      const task = { ...fill[0], memorySpaceId: input.memorySpaceId, runId: crypto.randomUUID(), kind: "init", initText: input.text, status: "running", errorMessage: null, from: 0, to: 0, processedCount: 0, totalCount: 0 } as FillTaskView;
      fill = [task, ...fill]; return task;
    },
    cancel: async (_space: string, runId: string) => {
      fill = fill.map(task => task.runId === runId ? { ...task, status: "interrupted" } : task);
      return fill.find(task => task.runId === runId);
    },
    retry: async (_space: string, runId: string) => {
      ensureIdle(); const original = fill.find(task => task.runId === runId)!;
      const task = { ...original, runId: crypto.randomUUID(), status: "running", errorMessage: null } as FillTaskView;
      fill = [task, ...fill]; return task;
    },
    markFloorStatuses: async (_space: string, from: number, to: number, status: FloorLedgerEntry["status"]) => {
      ensureIdle(); ledger = ledger.filter(item => item.floor < from || item.floor > to);
      if (status !== "untracked") for (let floor = from; floor <= to; floor++) ledger.push({ floor, status });
    },
  };
  Object.assign(runtime.vector, {
    listTasks: async (filters: VectorTaskFilters = {}) => {
      const matches = vectors.filter(task => (!filters.memorySpaceId || task.memorySpaceId === filters.memorySpaceId)
        && (!filters.tableId || task.tableId === filters.tableId) && (!filters.statuses || filters.statuses.includes(task.status))
        && (!filters.source || task.source === filters.source) && (!filters.search || `${task.recordDisplayText} ${task.groupName}`.includes(filters.search)));
      return { items: matches.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? matches.length)), total: matches.length,
        queued: vectors.filter(task => task.status === "queued").length, running: vectors.filter(task => task.status === "running").length,
        blocked: vectors.filter(task => task.status === "queued" && task.waitReason).length };
    },
    cancel: async (id: string) => { vectors = vectors.map(task => task.id === id ? { ...task, status: "cancelled", endedAt: now } : task); },
    cancelMany: async (ids: string[]) => { vectors = vectors.map(task => ids.includes(task.id) ? { ...task, status: "cancelled", endedAt: now } : task); },
    retry: async (id: string) => { const original = vectors.find(task => task.id === id)!; vectors = [{ ...original, id: crypto.randomUUID(), status: "queued", predecessorId: id, error: null, endedAt: null }, ...vectors]; },
  });
  return () => ({ fill, ledger, vectors });
}
