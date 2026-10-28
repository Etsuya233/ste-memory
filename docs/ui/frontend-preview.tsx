/** Deterministic UI fixture: no ST, database, model requests, or user data. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { WorkbenchApp } from "../../src/frontend/workbench.tsx";
import {
  TasksWorkspace,
  type TasksServices,
} from "../../src/frontend/pages/tasks/tasks-workspace.ts";
import type { FillTaskView } from "../../src/features/fill-tasks/fill-task.ts";
import type { VectorTask } from "../../src/features/vector-index/types.ts";
import { DEFAULT_SETTINGS } from "../../src/features/settings/plugin-settings.ts";
import { SettingsService } from "../../src/features/settings/settings-service.ts";
import type { SettingsServices } from "../../src/frontend/pages/settings/SettingsPage.tsx";
import { TablesWorkspace } from "../../src/frontend/pages/tables/tables-workspace.ts";
import { FrontendPanel } from "../../src/frontend/host/panel.tsx";
import { RecordsWorkspace } from "../../src/frontend/pages/records-workspace.ts";
import type { RecordsContext } from "../../src/frontend/pages/records-workspace.ts";
import type { SpaceContextStatus } from "../../src/features/chat-binding/chat-space-manager.ts";
import type {
  MemoryField,
  MemoryTableRepository,
  MemoryFieldRepository,
  MemoryRecordRepository,
  MemorySpaceRepository,
  MemorySpace,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryTable,
} from "../../src/features/memory/index.ts";
import {
  MemoryTableService,
  MemoryFieldService,
  MemoryRecordService,
  MemoryRecordSaveError,
} from "../../src/features/memory/index.ts";
import { Button } from "../../src/ui/primitives/button.tsx";
import { NativeSelect } from "../../src/ui/primitives/native-select.tsx";

const date = "2026-10-28T09:00:00.000Z";
const contexts = {
  a: { chatKey: "char:1:bookshop", spaceId: "space-a", title: "雨后书店 · 爱丽丝" },
  b: { chatKey: "char:2:harbour", spaceId: "space-b", title: "旧港来信 · 林舟" },
} as unknown as Record<"a" | "b", RecordsContext>;
let tables = Object.values(contexts).flatMap((context) =>
  ["人物", "地点", "纪要"].map((name, index) => ({
    id: `${context.spaceId}-table-${index}`,
    memorySpaceId: context.spaceId,
    key: `table_${index}`,
    name,
    description: "",
    prompt: "",
    enabled: true,
    position: index,
    displayStrategy: { type: "field", fieldId: "name" },
    createdAt: date,
    updatedAt: date,
  })),
) as unknown as MemoryTable[];
let fields = tables.flatMap((table) =>
  [
    { id: "name", name: "名称", type: "short_text", required: true },
    { id: "notes", name: "描述", type: "long_text" },
    { id: "active", name: "活跃", type: "boolean" },
    { id: "role", name: "身份", type: "single_select", options: ["旅人", "学者", "守卫"] },
    { id: "tags", name: "标签", type: "multi_select", options: ["朋友", "同伴", "初次见面"] },
    { id: "count", name: "相遇次数", type: "integer" },
    { id: "date", name: "最近见面", type: "date" },
    {
      id: "place",
      name: "常去地点",
      type: "single_reference",
      referenceTableId: `${table.memorySpaceId}-table-1`,
    },
    { id: "legacy", name: "旧备注", type: "short_text", enabled: false },
  ].map((field, index) => ({
    memorySpaceId: table.memorySpaceId,
    tableId: table.id,
    key: field.id,
    prompt: "",
    required: false,
    enabled: true,
    position: index,
    options: [],
    referenceTableId: null,
    maxChars: null,
    valuePattern: null,
    valuePatternMessage: null,
    createdAt: date,
    updatedAt: date,
    ...field,
  })),
) as unknown as MemoryField[];
let records = Object.values(contexts).flatMap((context) =>
  Array.from({ length: 26 }, (_, index) => ({
    id: `${context.spaceId}-record-${index}`,
    memorySpaceId: context.spaceId,
    tableId: `${context.spaceId}-table-${index === 25 ? 1 : 0}`,
    payload: {
      name:
        index === 25
          ? "雨巷书店"
          : index === 0
            ? context === contexts.a
              ? "爱丽丝"
              : "林舟"
            : `旅人 ${String(index).padStart(2, "0")}`,
      notes: "在雨后的书店交换了名字。她正在寻找一本关于旧港口的手记，约好下次见面时带上地图。",
      active: true,
      role: "旅人",
      tags: ["朋友"],
      count: 3,
      date: "2026-10-27",
      place: index === 25 ? null : `${context.spaceId}-record-25`,
      legacy: "这段停用字段内容应始终保留",
    },
    displayText:
      index === 25
        ? "雨巷书店"
        : index === 0
          ? context === contexts.a
            ? "爱丽丝"
            : "林舟"
          : `旅人 ${String(index).padStart(2, "0")}`,
    fieldEvidence:
      index === 0
        ? {
            notes: [
              {
                evidence_id: "evidence-1",
                source_type: "sync_floor",
                source_id: 7,
                storage_mode: "reference",
                extraProps: {},
              },
            ],
          }
        : {},
    source: { type: "manual" },
    revisionId: `revision-${context.spaceId}-${index}`,
    revisionSource: "user",
    createdAt: date,
    updatedAt: date,
  })),
) as unknown as MemoryRecord[];
const history: MemoryRecordHistory[] = [];
let current: "a" | "b" = "a";
let ready = true;
let serial = 100;
let failSave = false;
let failPersistence = false;
let delaySave = 0;
let delaySchemaSave = 0;
const tableRepository: MemoryTableRepository = {
  list: async (spaceId) =>
    structuredClone(tables.filter((table) => table.memorySpaceId === spaceId)),
  find: async (spaceId, id) =>
    structuredClone(tables.find((table) => table.memorySpaceId === spaceId && table.id === id)),
  findByKey: async (spaceId, key) =>
    structuredClone(tables.find((table) => table.memorySpaceId === spaceId && table.key === key)),
  create: async (table) => {
    tables.push(structuredClone(table));
  },
  update: async (table) => {
    const delay = delaySchemaSave;
    delaySchemaSave = 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const index = tables.findIndex((item) => item.id === table.id);
    if (index < 0) return false;
    tables[index] = structuredClone(table);
    return true;
  },
  delete: async (spaceId, id) => {
    const exists = tables.some((table) => table.memorySpaceId === spaceId && table.id === id);
    tables = tables.filter((table) => table.memorySpaceId !== spaceId || table.id !== id);
    fields = fields.filter((field) => field.memorySpaceId !== spaceId || field.tableId !== id);
    records = records.filter((record) => record.memorySpaceId !== spaceId || record.tableId !== id);
    return exists;
  },
};
const fieldRepository: MemoryFieldRepository = {
  list: async (spaceId, tableId) =>
    structuredClone(
      fields.filter((field) => field.memorySpaceId === spaceId && field.tableId === tableId),
    ),
  find: async (spaceId, tableId, id) =>
    structuredClone(
      fields.find(
        (field) => field.memorySpaceId === spaceId && field.tableId === tableId && field.id === id,
      ),
    ),
  findByKey: async (spaceId, tableId, key) =>
    structuredClone(
      fields.find(
        (field) =>
          field.memorySpaceId === spaceId && field.tableId === tableId && field.key === key,
      ),
    ),
  create: async (field) => {
    fields.push(structuredClone(field));
  },
  update: async (field) => {
    const index = fields.findIndex(
      (item) =>
        item.memorySpaceId === field.memorySpaceId &&
        item.tableId === field.tableId &&
        item.id === field.id,
    );
    if (index < 0) return false;
    fields[index] = structuredClone(field);
    return true;
  },
  delete: async (spaceId, tableId, id) => {
    const index = fields.findIndex(
      (field) => field.memorySpaceId === spaceId && field.tableId === tableId && field.id === id,
    );
    if (index < 0) return false;
    fields.splice(index, 1);
    return true;
  },
};
const recordRepository: MemoryRecordRepository = {
  list: async (spaceId, tableId) =>
    structuredClone(
      records.filter((record) => record.memorySpaceId === spaceId && record.tableId === tableId),
    ),
  find: async (spaceId, tableId, id) =>
    structuredClone(
      records.find(
        (record) =>
          record.memorySpaceId === spaceId && record.tableId === tableId && record.id === id,
      ),
    ),
  create: async (record) => {
    records.push(structuredClone(record));
  },
  commit: async (mutations) => {
    for (const mutation of mutations) {
      if (mutation.kind === "create") records.push(structuredClone(mutation.current));
      else {
        history.push(structuredClone(mutation.history));
        records = records.filter((record) => record.id !== mutation.previous.id);
        if (mutation.current) records.push(structuredClone(mutation.current));
      }
    }
    return true;
  },
  listHistory: async (query) =>
    structuredClone(
      history.filter(
        (entry) =>
          entry.memorySpaceId === query.memorySpaceId &&
          (!query.tableId || entry.tableId === query.tableId) &&
          (!query.recordId || entry.recordId === query.recordId),
      ),
    ),
};
const spaces: MemorySpace[] = Object.values(contexts).map((context) => ({
  id: context.spaceId,
  name: context.title,
  initializationSource: null,
  createdAt: date,
  updatedAt: date,
}));
const spaceRepository: MemorySpaceRepository = {
  find: async (id) => structuredClone(spaces.find((space) => space.id === id)),
  list: async () => structuredClone(spaces),
  create: async (space) => {
    spaces.push(space);
  },
  delete: async () => {
    throw new Error("预览不提供空间删除");
  },
  rename: async () => {
    throw new Error("预览不提供空间改名");
  },
  setMacros: async () => {
    throw new Error("预览不提供宏配置");
  },
  clearRecords: async () => {
    throw new Error("预览不提供清空空间");
  },
  deleteAllTables: async () => {
    throw new Error("预览不提供重建空间");
  },
};
const tableService = new MemoryTableService(
  spaceRepository,
  tableRepository,
  () => `table-${++serial}` as MemoryTable["id"],
  () => new Date().toISOString(),
  fieldRepository,
);
const fieldService = new MemoryFieldService(
  tableRepository,
  fieldRepository,
  () => `field-${++serial}` as MemoryField["id"],
  () => new Date().toISOString(),
);
const recordService = new MemoryRecordService(
  tableRepository,
  fieldRepository,
  recordRepository,
  () => `record-${++serial}` as MemoryRecord["id"],
  () => `history-${++serial}` as MemoryRecordHistory["id"],
  () => `revision-${++serial}` as MemoryRecord["revisionId"],
  () => new Date().toISOString(),
);
const assertContext = (context: RecordsContext) => {
  if (!ready || context.chatKey !== contexts[current].chatKey)
    throw new Error("对话已切换，请返回原对话保存");
};
const workspace = new RecordsWorkspace({
  tables: { list: async (spaceId) => tables.filter((table) => table.memorySpaceId === spaceId) },
  fields: {
    list: async (spaceId, tableId) =>
      fields.filter((field) => field.memorySpaceId === spaceId && field.tableId === tableId),
  },
  records: {
    list: async (spaceId, tableId, options) => {
      const filtered = records.filter(
        (record) =>
          record.memorySpaceId === spaceId &&
          record.tableId === tableId &&
          (!options.search || JSON.stringify(record.payload).includes(options.search)),
      );
      const page = options.page ?? 1,
        pageSize = options.pageSize ?? 20;
      return {
        records: structuredClone(filtered.slice((page - 1) * pageSize, page * pageSize)),
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / pageSize),
      };
    },
    find: async (spaceId, tableId, id) =>
      structuredClone(
        records.find(
          (record) =>
            record.memorySpaceId === spaceId && record.tableId === tableId && record.id === id,
        ),
      ),
    listHistory: async (spaceId, query) =>
      history.filter(
        (entry) =>
          entry.memorySpaceId === spaceId &&
          entry.tableId === query.tableId &&
          entry.recordId === query.recordId,
      ),
    update: async (spaceId, tableId, id, input) => {
      const delay = delaySave;
      delaySave = 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (failSave) {
        failSave = false;
        throw new Error("模拟保存失败，请重试；草稿仍然保留");
      }
      const record = records.find(
        (record) =>
          record.id === id && record.memorySpaceId === spaceId && record.tableId === tableId,
      );
      if (!record) return undefined;
      if (record.revisionId !== input.expectedRevisionId)
        throw Object.assign(new Error("记录已被其他操作更新，请保留草稿后重新编辑"), {
          type: "memory_record_revision_conflict",
        });
      const payload = { ...record.payload, ...input.patch };
      const updated = {
        ...record,
        payload,
        displayText: String(payload.name),
        revisionId: `revision-${++serial}`,
        updatedAt: new Date().toISOString(),
      } as MemoryRecord;
      history.push({
        ...record,
        id: `history-${serial}`,
        recordId: record.id,
        archivedAt: updated.updatedAt,
      } as MemoryRecordHistory);
      records = records.map((item) => (item.id === id ? updated : item));
      if (failPersistence) {
        failPersistence = false;
        throw new MemoryRecordSaveError(updated, new Error("记录已提交，但对话文件写回失败"));
      }
      return structuredClone(updated);
    },
    create: async (spaceId, tableId, input) => {
      const created = {
        id: `record-${++serial}`,
        memorySpaceId: spaceId,
        tableId,
        payload: input.payload,
        fieldEvidence: {},
        displayText: String(input.payload.name),
        source: { type: "manual" },
        revisionId: `revision-${serial}`,
        revisionSource: "user",
        createdAt: date,
        updatedAt: date,
      } as MemoryRecord;
      records.push(created);
      if (failPersistence) {
        failPersistence = false;
        throw new MemoryRecordSaveError(created, new Error("记录已提交，但对话文件写回失败"));
      }
      return structuredClone(created);
    },
  },
  assertContext: (context) => {
    if (!ready || context.chatKey !== contexts[current].chatKey)
      throw new Error("对话已切换，请返回原对话保存");
  },
  onSaved: async () => {},
});
const tablesWorkspace = new TablesWorkspace({
  tables: tableService,
  fields: fieldService,
  records: recordService,
  vectorIndex: {
    submit: async () => ({ created: 1, reused: 0, promoted: 0, skipped: 0 }),
    clear: async () => {},
    getTableSummary: async (scope) => ({
      records: (await recordRepository.list(scope.memorySpaceId, scope.tableId)).length,
      ready: 0,
      stale: 0,
      errors: 0,
      empty: 0,
      queued: 0,
    }),
    previewDraftSummary: async (scope, configuration) => {
      const count = (await recordRepository.list(scope.memorySpaceId, scope.tableId)).length;
      const vectors = configuration.enabled ? count * Math.max(1, configuration.groups.length) : 0;
      return {
        records: count,
        vectors,
        ready: 0,
        pending: vectors,
        empty: 0,
        invalid: 0,
        tooLong: 0,
        unavailable: 0,
      };
    },
  },
  assertContext,
  onChanged: async (context) => {
    if (workspace.getSnapshot().context?.chatKey === context.chatKey) await workspace.refresh();
  },
  retryMemorySave: async () => {},
});
let settingsValue = structuredClone(DEFAULT_SETTINGS);
let notifySettingsChanged: () => Promise<void> = async () => {};
const settingsService = new SettingsService({
  store: {
    read: () => structuredClone(settingsValue),
    write: (value) => {
      settingsValue = structuredClone(value);
    },
  },
  syncToCurrentChat: async () => {},
  refreshMemoryMacros: async () => {},
  refreshAgentMacros: async () => {},
  refreshMirror: async () => {},
  writeChatScopeMacros: () => {},
  refreshVectorIndex: async () => {},
  validateMacros: async (macros) => macros,
  getChatScopeMacros: () => [],
  getChatContext: () => contexts[current].chatKey,
});
const settingsServices: SettingsServices = {
  settings: settingsService,
  onChanged: () => notifySettingsChanged(),
  version: "preview",
};
const fillTasks: FillTaskView[] = Object.values(contexts).map((context) => ({
  runId: `${context.spaceId}-failed-fill`,
  memorySpaceId: context.spaceId,
  from: 4,
  to: 7,
  blockSize: 4,
  chatId: context.chatKey,
  status: "failed",
  errorMessage: "预览模拟：连接临时失败",
  createdAt: date,
  updatedAt: date,
  kind: "floor",
  initText: null,
  processedCount: 0,
  totalCount: 4,
  blocksQueue: true,
}));
const vectorTasks: VectorTask[] = Object.values(contexts).flatMap((context) =>
  (["queued", "failed"] as const).map((status, index) => ({
    id: `${context.spaceId}-vector-${status}`,
    memorySpaceId: context.spaceId,
    tableId: `${context.spaceId}-table-0` as MemoryTable["id"],
    recordId: `${context.spaceId}-record-${index}` as MemoryRecord["id"],
    recordDisplayText: index ? "旅人 01" : "爱丽丝",
    groupId: "automatic",
    groupName: "全部字段",
    fingerprint: `fixture-${index}`,
    input: "预览向量文本",
    model: "fixture-embedding",
    version: "fixture",
    dimensions: 3,
    source: index ? "automatic" : "manual",
    force: false,
    predecessorId: null,
    status,
    waitReason: null,
    error: index ? "预览模拟：向量连接失败" : null,
    createdAt: date,
    startedAt: null,
    endedAt: null,
  })),
);
const taskServices: TasksServices = {
  tasks: {
    pendingTasks: async (spaceId) =>
      structuredClone(
        fillTasks.filter(
          (task) =>
            task.memorySpaceId === spaceId &&
            (task.status === "queued" || task.status === "running" || task.blocksQueue),
        ),
      ),
    recentTasks: async (spaceId, limit) =>
      structuredClone(
        fillTasks
          .filter((task) => task.memorySpaceId === spaceId)
          .slice(-limit)
          .reverse(),
      ),
    ledgerStatuses: async (_spaceId, from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({
        floor: from + i,
        status: from + i < 4 ? ("processed" as const) : ("untracked" as const),
      })),
    submit: async (input) => {
      const task: FillTaskView = {
        runId: `fill-${++serial}`,
        memorySpaceId: input.memorySpaceId,
        kind: "floor",
        initText: null,
        from: input.from,
        to: input.to,
        blockSize: input.blockSize ?? 20,
        chatId: contexts[current].chatKey,
        status: "queued",
        errorMessage: null,
        createdAt: date,
        updatedAt: date,
        processedCount: 0,
        totalCount: input.to - input.from + 1,
      };
      fillTasks.push(task);
      return structuredClone(task);
    },
    submitInit: async (input) => {
      const task: FillTaskView = {
        runId: `init-${++serial}`,
        memorySpaceId: input.memorySpaceId,
        kind: "init",
        initText: input.text,
        from: 0,
        to: 0,
        blockSize: 1,
        chatId: contexts[current].chatKey,
        status: "queued",
        errorMessage: null,
        createdAt: date,
        updatedAt: date,
        processedCount: 0,
        totalCount: 1,
      };
      fillTasks.push(task);
      return structuredClone(task);
    },
    cancel: async (spaceId, id) => {
      const index = fillTasks.findIndex(
        (task) => task.memorySpaceId === spaceId && task.runId === id,
      );
      if (index < 0) throw new Error("任务不存在");
      const task = { ...fillTasks[index]!, status: "interrupted" as const, blocksQueue: false };
      fillTasks[index] = task;
      return structuredClone(task);
    },
    retry: async (spaceId, id) => {
      const index = fillTasks.findIndex(
        (task) => task.memorySpaceId === spaceId && task.runId === id,
      );
      if (index < 0) throw new Error("任务不存在");
      const task = {
        ...fillTasks[index]!,
        status: "queued" as const,
        errorMessage: null,
        blocksQueue: false,
      };
      fillTasks[index] = task;
      return structuredClone(task);
    },
  },
  vector: {
    listTasks: async (filters = {}) => {
      const matches = vectorTasks.filter(
        (task) =>
          (!filters.memorySpaceId || task.memorySpaceId === filters.memorySpaceId) &&
          (!filters.statuses || filters.statuses.includes(task.status)) &&
          (!filters.source || task.source === filters.source),
      );
      const offset = filters.offset ?? 0;
      return {
        items: structuredClone(matches.slice(offset, offset + (filters.limit ?? 30))),
        total: matches.length,
        queued: matches.filter((task) => task.status === "queued").length,
        running: matches.filter((task) => task.status === "running").length,
        blocked: 0,
      };
    },
    cancel: async (id) => {
      const index = vectorTasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error("向量任务不存在");
      vectorTasks[index] = { ...vectorTasks[index]!, status: "cancelled" };
      return true;
    },
    cancelMany: async (ids) => {
      for (const id of ids) {
        const index = vectorTasks.findIndex((task) => task.id === id);
        if (index < 0) throw new Error("向量任务不存在");
        vectorTasks[index] = { ...vectorTasks[index]!, status: "cancelled" };
      }
      return ids.length;
    },
    retry: async (id) => {
      const index = vectorTasks.findIndex((task) => task.id === id);
      if (index < 0) throw new Error("向量任务不存在");
      vectorTasks[index] = { ...vectorTasks[index]!, status: "queued", error: null };
      return { created: 1, reused: 0, promoted: 0, skipped: 0 };
    },
  },
  messageCount: () => 12,
  assertContext,
};
const tasksWorkspace = new TasksWorkspace(taskServices);
function activeStatus(): SpaceContextStatus {
  const context = contexts[current];
  return {
    kind: "active",
    binding: { version: 2, spaceId: context.spaceId, chatIdentity: context.chatKey },
    space: { id: context.spaceId, name: context.title, createdAt: date, updatedAt: date },
    created: false,
    restored: false,
  } as SpaceContextStatus;
}
function Preview() {
  const [status, setStatus] = useState<SpaceContextStatus | undefined>(activeStatus);
  const [tone, setTone] = useState<"light" | "dark">(
    location.search.includes("dark") ? "dark" : "light",
  );
  const [open, setOpen] = useState(true);
  const [, setSettingsRevision] = useState(0);
  notifySettingsChanged = async () => {
    ready = settingsValue.enabled;
    setStatus(ready ? activeStatus() : undefined);
    const context = ready ? contexts[current] : null;
    await Promise.all([
      workspace.setContext(context),
      tablesWorkspace.setContext(context),
      tasksWorkspace.setContext(context),
    ]);
    setSettingsRevision((value) => value + 1);
  };
  async function switchChat(next: "a" | "b") {
    ready = false;
    setStatus(undefined);
    await Promise.all([
      workspace.setContext(null),
      tablesWorkspace.setContext(null),
      tasksWorkspace.setContext(null),
    ]);
    current = next;
    ready = settingsValue.enabled;
    setStatus(ready ? activeStatus() : undefined);
    const context = ready ? contexts[next] : null;
    await Promise.all([
      workspace.setContext(context),
      tablesWorkspace.setContext(context),
      tasksWorkspace.setContext(context),
    ]);
  }
  Object.assign(window, {
    frontendPreview: {
      switchChat,
      workspace,
      snapshot: () => structuredClone(records),
      tablesWorkspace,
      tasksWorkspace,
      settingsSnapshot: () => structuredClone(settingsValue),
      tasksSnapshot: () => structuredClone({ fillTasks, vectorTasks }),
      delayNextSchemaSave: (ms: number) => {
        delaySchemaSave = ms;
      },
      schemaSnapshot: () => structuredClone({ tables, fields }),
      failNextSave: () => {
        failSave = true;
      },
      failNextPersistence: () => {
        failPersistence = true;
      },
      delayNextSave: (ms: number) => {
        delaySave = ms;
      },
      changeRecord: () => {
        records = records.map((record, index) =>
          index === 0
            ? ({ ...record, revisionId: `external-${++serial}` } as MemoryRecord)
            : record,
        );
      },
    },
  });
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开预览</Button>
      <FrontendPanel open={open} tone={tone}>
        <div className="ste:flex ste:h-full ste:flex-col">
          <div className="ste:flex ste:shrink-0 ste:items-center ste:gap-3 ste:border-b ste:border-border ste:bg-muted ste:px-4 ste:py-2">
            <span className="ste:text-xs ste:text-muted-foreground">预览对话</span>
            <NativeSelect
              aria-label="预览对话"
              size="sm"
              value={current}
              onChange={(event) => void switchChat(event.target.value as "a" | "b")}
            >
              <option value="a">雨后书店</option>
              <option value="b">旧港来信</option>
            </NativeSelect>
          </div>
          <div className="ste:min-h-0 ste:flex-1">
            <WorkbenchApp
              active={open}
              tables={tablesWorkspace}
              tasks={tasksWorkspace}
              settings={settingsServices}
              workspace={workspace}
              status={status}
              mirror={
                settingsValue.enabled && settingsValue.mirror.enabled
                  ? { kind: "idle", lastWrittenAt: date, sizeBytes: 1000 }
                  : { kind: "disabled" }
              }
              onClose={() => setOpen(false)}
              onToggleTone={() => setTone(tone === "light" ? "dark" : "light")}
              onRetryContext={() => switchChat(current)}
              onResolveBranch={() => switchChat(current)}
              onRetrySave={async () => {}}
              getMessageAt={(floor) => ({
                floor,
                name: "爱丽丝",
                content: "雨后的街角，她说：我是爱丽丝。下次来书店时记得带上地图。",
                isUser: false,
                options: { needCleaning: false },
              })}
              onJumpFloor={() => ({ kind: "jumped" })}
            />
          </div>
        </div>
      </FrontendPanel>
    </>
  );
}
await Promise.all([
  workspace.setContext(contexts.a),
  tablesWorkspace.setContext(contexts.a),
  tasksWorkspace.setContext(contexts.a),
]);
createRoot(document.getElementById("root")!).render(<Preview />);
