import { MemoryRecordQueryService } from "../../src/features/memory/index.ts";
/** Deterministic UI fixture: no ST, database, model requests, or user data. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { WorkbenchApp } from "../../src/frontend/workbench.tsx";
import { createToolsFixture } from "./frontend-tools-fixture.ts";
import { createPresetUpdateFixture } from "./frontend-preset-update-fixture.ts";
import {
  validateAutoFillSettings,
  type AutoFillChatState,
  type AutoFillSettings,
} from "../../src/features/fill-tasks/auto-fill-settings.ts";
import {
  TasksWorkspace,
  type TasksServices,
} from "../../src/frontend/pages/tasks/tasks-workspace.ts";
import type { FillTaskView } from "../../src/features/fill-tasks/fill-task.ts";
import type {
  VectorTask,
  RecordVector,
  VectorIndexRepository,
  VectorEmbeddingPort,
} from "../../src/features/vector-index/types.ts";
import { VectorIndexService } from "../../src/features/vector-index/vector-index-service.ts";
import { VectorRetrievalService } from "../../src/features/vector-retrieval/vector-retrieval-service.ts";
import {
  DEFAULT_SETTINGS,
  type PluginSettings,
} from "../../src/features/settings/plugin-settings.ts";
import { SettingsService } from "../../src/features/settings/settings-service.ts";
import type { SettingsServices } from "../../src/frontend/pages/settings/SettingsPage.tsx";
import type { MacroServices } from "../../src/frontend/pages/settings/macros-page.tsx";
import type { CleaningServices } from "../../src/frontend/pages/settings/cleaning-rules-page.tsx";
import type {
  PresetSettingsServices,
  PresetContext,
} from "../../src/frontend/pages/settings/preset-settings-services.ts";
import type { MemoryMacro } from "../../src/features/macros/macro-expression.ts";
import { validateMemoryMacro } from "../../src/features/macros/macro-expression.ts";
import { captureSpaceStructure } from "../../src/features/table-presets/space-structure-capture.ts";
import { instantiateTablePreset } from "../../src/features/table-presets/preset-instantiation.ts";
import {
  parseTablePresetExport,
  serializeTablePresetExport,
} from "../../src/features/table-presets/preset-transfer.ts";
import { EMPTY_PREVIEW_SNAPSHOT } from "../../src/features/agent-presets/preset-preview-model.ts";
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
import { Button } from "../../src/frontend/primitives/button.tsx";
import { NativeSelect } from "../../src/frontend/primitives/native-select.tsx";

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
      count: index === 0 ? 3 : index === 24 ? null : index,
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
    createdAt: new Date(Date.parse(date) + index * 1000).toISOString(),
    updatedAt: new Date(Date.parse(date) + (26 - index) * 1000).toISOString(),
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
  if (
    !ready ||
    context.chatKey !== contexts[current].chatKey ||
    context.spaceId !== contexts[current].spaceId
  )
    throw new Error("对话已切换，请返回原对话保存");
};
const workspace = new RecordsWorkspace({
  sortStorage: localStorage,
  tables: { list: async (spaceId) => tables.filter((table) => table.memorySpaceId === spaceId) },
  fields: {
    list: async (spaceId, tableId) =>
      fields.filter((field) => field.memorySpaceId === spaceId && field.tableId === tableId),
  },
  records: {
    list: (spaceId, tableId, options) => recordService.list(spaceId, tableId, options),
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
  assertContext,
  onSaved: async () => {},
});
const tablesWorkspace = new TablesWorkspace({
  tables: tableService,
  fields: fieldService,
  records: recordService,
  vectorIndex: {
    preview: (scope) => searchIndex.preview(scope),
    previewDraft: (scope, configuration) => searchIndex.previewDraft(scope, configuration),
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
let settingsValue: PluginSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  cleaningRules: [
    {
      id: "preview-cleaning",
      name: "去思考标签",
      enabled: true,
      keepTags: [],
      excludeTags: [{ pre: "<think>", post: "</think>" }],
    },
  ],
  agentPresets: {
    presets: [
      {
        id: "preview-preset",
        name: "预览预设",
        messages: [
          {
            id: "preview-preset-message",
            name: "系统提示",
            role: "system" as const,
            content: "预览用 Agent 预设",
            enabled: true,
          },
        ],
      },
      {
        id: "preview-chat-preset",
        name: "对话预设",
        messages: [
          {
            id: "preview-chat-preset-message",
            name: "系统提示",
            role: "system" as const,
            content: "仅当前对话使用",
            enabled: true,
          },
        ],
      },
    ],
    activePresetId: "preview-preset",
  },
};
const chatMacros = new Map<string, readonly MemoryMacro[]>();
const cleaningSelections = new Map<string, string>();
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
  writeChatScopeMacros: (macros) => {
    chatMacros.set(contexts[current].chatKey, structuredClone(macros));
  },
  refreshVectorIndex: async () => {},
  validateMacros: async (macros) => macros,
  getChatScopeMacros: () => chatMacros.get(contexts[current].chatKey) ?? [],
  getChatContext: () => contexts[current].chatKey,
});
const settingsServices: SettingsServices = {
  settings: settingsService,
  testAgentConnection: async () => ({ ok: true, models: ["preview-chat", "preview-reasoning"] }),
  onChanged: () => notifySettingsChanged(),
  version: "preview",
};
const cleaningServices: CleaningServices = {
  readSelection: () => cleaningSelections.get(contexts[current].chatKey),
  writeSelection: (id) => {
    if (id) cleaningSelections.set(contexts[current].chatKey, id);
    else cleaningSelections.delete(contexts[current].chatKey);
  },
  readRecentMessages: () => [
    {
      floor: 10,
      name: "爱丽丝",
      content: "<think>AI秘密</think>雨后的书店",
      isUser: false,
      options: { needCleaning: true },
    },
    {
      floor: 11,
      name: "旅人",
      content: "<think>用户原文</think>带上地图",
      isUser: true,
      options: { needCleaning: false },
    },
  ],
};
const macroResults: ReturnType<MacroServices["macro"]["getRecentResults"]> = [];
let macroTestDelay = 0;
const macroServices: MacroServices = {
  settings: settingsService,
  readChatMacros: () => chatMacros.get(contexts[current].chatKey) ?? [],
  macro: {
    getRecentResults: () => macroResults,
    subscribe: () => () => {},
    testMacro: async ({ macro, scope }) => {
      if (macroTestDelay) await new Promise((resolve) => setTimeout(resolve, macroTestDelay));
      validateMemoryMacro(macro);
      return {
        id: macro.id,
        name: macro.name,
        scope,
        status: "success",
        text: "预览模拟输出：雨后书店",
        error: null,
        startedAt: date,
        elapsedMs: 1,
        resultRows: 1,
        outputRows: 1,
        truncated: false,
        diagnostics: [],
      };
    },
  },
  overview: () => [{ name: "{{ste}}", text: "预览模拟快照：雨后书店" }],
  tables: tableService,
  fields: fieldService,
  assertContext,
};
const presetIds = {
  table: () => `preset-table-${++serial}` as MemoryTable["id"],
  field: () => `preset-field-${++serial}` as MemoryField["id"],
  group: () => `preset-group-${++serial}`,
};
let presetBackupCancelled = false;
const assertPresetContext = (context: PresetContext) =>
  assertContext({ chatKey: context.chatIdentity, spaceId: context.spaceId, title: context.title });
const presetUpdateFixture = createPresetUpdateFixture({
  read: (spaceId) => {
    const ownRecords = records.filter((record) => record.memorySpaceId === spaceId);
    const ownHistory = history.filter((record) => record.memorySpaceId === spaceId);
    const evidence = new Map(
      [...ownRecords, ...ownHistory]
        .flatMap((record) => Object.values(record.fieldEvidence).flat())
        .map((entry) => [entry.evidence_id, entry]),
    );
    return structuredClone({
      space: spaces.find((space) => space.id === spaceId)!,
      tables: tables.filter((table) => table.memorySpaceId === spaceId),
      fields: fields.filter((field) => field.memorySpaceId === spaceId),
      records: ownRecords,
      history: ownHistory,
      evidence: [...evidence.values()],
    });
  },
  write: (unit) => {
    spaces[spaces.findIndex((space) => space.id === unit.space.id)] = structuredClone(unit.space);
    tables = [...tables.filter((table) => table.memorySpaceId !== unit.space.id), ...unit.tables];
    fields = [...fields.filter((field) => field.memorySpaceId !== unit.space.id), ...unit.fields];
    records = [
      ...records.filter((record) => record.memorySpaceId !== unit.space.id),
      ...unit.records,
    ];
    const retained = history.filter((record) => record.memorySpaceId !== unit.space.id);
    history.splice(0, history.length, ...retained, ...unit.history);
  },
  assert: (spaceId, chatIdentity) => assertPresetContext({ spaceId, chatIdentity, title: "" }),
  changed: async () => {
    await Promise.all([workspace.refresh(), tablesWorkspace.refresh(), tasksWorkspace.refresh()]);
  },
  ids: presetIds,
});
const presetServices: PresetSettingsServices = {
  spaceUpdate: presetUpdateFixture.service,
  agentPreview: {
    getPromptSnapshot: () => ({
      ...EMPTY_PREVIEW_SNAPSHOT,
      names: { char: "爱丽丝", user: "旅人" },
    }),
    readSpaceId: () => (ready ? contexts[current].spaceId : undefined),
    readDigest: async (memorySpaceId) => ({ memorySpaceId, tables: [] }),
    scanWorldbook: async () => ({ text: "预览世界书", status: "scanned" }),
  },
  currentContext: () =>
    ready
      ? {
          spaceId: contexts[current].spaceId,
          chatIdentity: contexts[current].chatKey,
          title: contexts[current].title,
        }
      : null,
  readCurrentStructure: async (context) => {
    assertPresetContext(context);
    return captureSpaceStructure(
      {
        listTables: (id) => tableService.list(id),
        listFields: (spaceId, tableId) => fieldService.list(spaceId, tableId),
      },
      context.spaceId,
    );
  },
  validateTablePreset: async (preset) => {
    parseTablePresetExport(serializeTablePresetExport(preset, date));
    instantiateTablePreset(preset, contexts[current].spaceId, presetIds, date);
    return preset;
  },
  backupCurrentSpace: async (context) => {
    assertPresetContext(context);
    return !presetBackupCancelled;
  },
  applyTablePreset: async (context, preset) => {
    assertPresetContext(context);
    const structure = instantiateTablePreset(preset, context.spaceId, presetIds, date);
    tables = [
      ...tables.filter((table) => table.memorySpaceId !== context.spaceId),
      ...structure.tables,
    ];
    fields = [
      ...fields.filter((field) => field.memorySpaceId !== context.spaceId),
      ...structure.fields,
    ];
    records = records.filter((record) => record.memorySpaceId !== context.spaceId);
    chatMacros.delete(context.chatIdentity);
    await Promise.all([workspace.refresh(), tablesWorkspace.refresh(), tasksWorkspace.refresh()]);
    return { kind: "applied" };
  },
};
let searchDelay = 10;
let searchFailure = false;
const searchVectors: RecordVector[] = [];
const searchRepository: VectorIndexRepository = {
  listTasks: async () => [],
  listVectors: async (scope) =>
    searchVectors.filter(
      (vector) =>
        vector.memorySpaceId === scope.memorySpaceId &&
        (!scope.tableId || vector.tableId === scope.tableId),
    ),
  saveVector: async (vector) => {
    searchVectors.push(vector);
  },
  getVector: async (id) => searchVectors.find((vector) => vector.id === id),
  deleteVector: async (id) => {
    const i = searchVectors.findIndex((vector) => vector.id === id);
    if (i >= 0) searchVectors.splice(i, 1);
  },
  deleteVectors: async (scope) => {
    for (let i = searchVectors.length - 1; i >= 0; i--) {
      const vector = searchVectors[i]!;
      if (
        vector.memorySpaceId === scope.memorySpaceId &&
        (!scope.tableId || vector.tableId === scope.tableId)
      )
        searchVectors.splice(i, 1);
    }
  },
  saveTask: async () => {
    throw new Error("检索预览不写入索引任务");
  },
  getTask: async () => undefined,
  deleteTasks: async () => {},
  saveSuppression: async () => {
    throw new Error("检索预览不写入抑制条目");
  },
  getSuppression: async () => undefined,
  deleteSuppression: async () => {},
  deleteSuppressions: async () => {},
  listSuppressions: async () => [],
};
const searchEmbedding: VectorEmbeddingPort = {
  getProfile: () =>
    settingsValue.embeddingConnection
      ? {
          model: settingsValue.embeddingConnection.model,
          version: "preview-v1",
          maxInputChars: settingsValue.embeddingConnection.maxInputChars,
          dimensions: 2,
        }
      : null,
  embed: async (_input, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, searchDelay);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
    if (searchFailure) {
      searchFailure = false;
      throw new Error("预览模拟：embedding连接失败");
    }
    return [1, 0];
  },
};
const searchIndex = new VectorIndexService(
  tableRepository,
  fieldRepository,
  recordRepository,
  searchEmbedding,
  searchRepository,
  () => (ready ? contexts[current].spaceId : null),
  () => settingsValue.enabled,
);
const searchService = new VectorRetrievalService(
  tableRepository,
  fieldRepository,
  searchIndex,
  searchRepository,
  searchEmbedding,
  () => (ready ? contexts[current].chatKey : ""),
);
function syncSearchContext() {
  searchService.setContext(
    ready ? contexts[current].chatKey : "",
    ready ? contexts[current].spaceId : null,
  );
}
async function seedSearch() {
  settingsService.save({
    ...settingsService.read(),
    embeddingConnection: {
      baseUrl: "https://preview.invalid/v1",
      apiKey: "preview",
      model: "preview-embedding",
      maxInputChars: 8000,
      timeoutSeconds: 120,
    },
  });
  const table = tables.find((table) => table.memorySpaceId === contexts[current].spaceId)!;
  await tableService.update(contexts[current].spaceId, table.id, {
    vectorIndex: { enabled: true, source: "automatic", updateMode: "manual", groups: [] },
  });
  searchVectors.length = 0;
  for (const target of await searchIndex.targets({
    memorySpaceId: contexts[current].spaceId,
    tableId: table.id,
  })) {
    searchVectors.push({
      id: `${target.table.id}-${target.record.id}-${target.groupId}`,
      memorySpaceId: contexts[current].spaceId,
      tableId: target.table.id,
      recordId: target.record.id,
      groupId: target.groupId,
      fingerprint: target.fingerprint,
      values: [1, 0],
      model: "preview-embedding",
      version: "preview-v1",
      updatedAt: date,
    });
  }
  await notifySettingsChanged();
}
const fillTasks: FillTaskView[] = Object.values(contexts).flatMap((context): FillTaskView[] => [
  {
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
  },
  {
    runId: `${context.spaceId}-running-fill`,
    memorySpaceId: context.spaceId,
    from: 8,
    to: 11,
    blockSize: 2,
    chatId: context.chatKey,
    status: "running",
    errorMessage: null,
    createdAt: date,
    updatedAt: date,
    kind: "floor",
    initText: null,
    processedCount: 1,
    totalCount: 4,
  },
]);
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
const agentPresetOverrides = new Map<string, string>();
const floorProgressOverrides = new Map<string, Map<number, "processed" | "untracked" | "error">>();
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
    ledgerStatuses: async (spaceId, from, to) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({
        floor: from + i,
        status:
          floorProgressOverrides.get(spaceId)?.get(from + i) ??
          (from + i < 4 || from + i === 8 ? ("processed" as const) : ("untracked" as const)),
      })),
    markFloorStatuses: async (spaceId, from, to, status) => {
      if (fillTasks.some((task) => task.memorySpaceId === spaceId && task.status === "running"))
        throw new Error("请等待运行中的填表任务结束后再标记");
      const floors = floorProgressOverrides.get(spaceId) ?? new Map();
      for (let floor = from; floor <= to; floor++) floors.set(floor, status);
      floorProgressOverrides.set(spaceId, floors);
    },
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
  chatConfig: {
    readCleaningSelection: () => cleaningSelections.get(contexts[current].chatKey),
    writeCleaningSelection: (id) => {
      if (id) cleaningSelections.set(contexts[current].chatKey, id);
      else cleaningSelections.delete(contexts[current].chatKey);
    },
    readAgentPresetOverride: () => agentPresetOverrides.get(contexts[current].chatKey),
    writeAgentPresetOverride: (id) => {
      if (id) agentPresetOverrides.set(contexts[current].chatKey, id);
      else agentPresetOverrides.delete(contexts[current].chatKey);
    },
  },
  messageCount: () => 12,
  assertContext,
};
const tasksWorkspace = new TasksWorkspace(taskServices);
const autoFillOverrides = new Map<string, Partial<AutoFillSettings>>();
const autoFillServices = {
  read: (): AutoFillChatState => ({
    overrides: autoFillOverrides.get(contexts[current].chatKey) ?? {},
    pausedReason: null,
  }),
  settings: () => ({
    ...settingsValue.autoFill,
    ...autoFillOverrides.get(contexts[current].chatKey),
  }),
  saveOverrides: (value: Partial<AutoFillSettings>) => {
    validateAutoFillSettings({ ...settingsValue.autoFill, ...value });
    autoFillOverrides.set(contexts[current].chatKey, structuredClone(value));
  },
  assertContext,
};
const toolsFixture = createToolsFixture({
  ports: { tables: tableRepository, fields: fieldRepository, records: recordRepository },
  recordWriter: recordService,
  reader: {
    getSpace: (id) => spaceRepository.find(id),
    listTables: (id) => tableRepository.list(id),
    listFields: (id, tableId) => fieldRepository.list(id, tableId),
    queryRecords: (id, query) =>
      new MemoryRecordQueryService(tableRepository, fieldRepository, recordRepository).query(
        id,
        query,
      ),
  },
  contexts: Object.values(contexts),
  current: () => (ready ? contexts[current] : null),
  read: () => ({ tables, fields, records }),
  write: (data) => {
    tables = data.tables;
    fields = data.fields;
    records = data.records;
  },
  changed: async () => {
    await Promise.all([workspace.refresh(), tablesWorkspace.refresh(), tasksWorkspace.refresh()]);
  },
  assertContext,
});
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
    syncSearchContext();
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
    syncSearchContext();
    setStatus(undefined);
    await Promise.all([
      workspace.setContext(null),
      tablesWorkspace.setContext(null),
      tasksWorkspace.setContext(null),
    ]);
    current = next;
    ready = settingsValue.enabled;
    syncSearchContext();
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
      queryStore: toolsFixture.queryStore,
      assistantService: toolsFixture.tools.query.service,
      queryInputs: toolsFixture.queryInputs,
      delayQuery: toolsFixture.delayQuery,
      delaySQL: toolsFixture.delaySQL,
      failNextQuery: toolsFixture.failNextQuery,
      snapshot: () => structuredClone(records),
      tablesWorkspace,
      tasksWorkspace,
      autoFillSnapshot: () => structuredClone([...autoFillOverrides]),
      agentPresetSnapshot: () => structuredClone([...agentPresetOverrides]),
      searchService,
      seedSearch,
      delaySearch: (ms: number) => {
        searchDelay = ms;
      },
      failNextSearch: () => {
        searchFailure = true;
      },
      cancelPresetBackup: (cancelled: boolean) => {
        presetBackupCancelled = cancelled;
      },
      presetUpdateState: presetUpdateFixture.state,
      delayPresetCompare: presetUpdateFixture.delayPreview,
      delayPresetUpdate: presetUpdateFixture.delayApply,
      delayPresetUpdateResult: presetUpdateFixture.delayResult,
      failNextPresetUpdateSync: presetUpdateFixture.failNextSync,
      removeSortingField: async (id: string) => {
        const context = contexts[current];
        const removed = fields.filter(
          (field) => field.id === id && field.memorySpaceId === context.spaceId,
        );
        fields = fields.filter((field) => !removed.includes(field));
        records = records.map((record) =>
          removed.some((field) => field.tableId === record.tableId)
            ? {
                ...record,
                payload: Object.fromEntries(
                  Object.entries(record.payload).filter(([key]) => key !== id),
                ),
                fieldEvidence: Object.fromEntries(
                  Object.entries(record.fieldEvidence).filter(([key]) => key !== id),
                ),
              }
            : record,
        );
        await workspace.refresh();
      },
      patchSortingRecords: async (
        updates: readonly {
          id: string;
          createdAt?: string;
          updatedAt?: string;
          payload?: MemoryRecord["payload"];
        }[],
      ) => {
        records = records.map((record) => {
          const update = updates.find((update) => update.id === record.id);
          return update
            ? {
                ...record,
                ...update,
                payload: { ...record.payload, ...update.payload },
                id: record.id,
              }
            : record;
        });
        await workspace.refresh();
      },
      chatMacrosSnapshot: () => structuredClone([...chatMacros]),
      delayMacroTest: (ms: number) => {
        macroTestDelay = ms;
      },
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
        const target = records.find((record) => record.memorySpaceId === contexts[current].spaceId);
        records = records.map((record) =>
          record.id === target?.id
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
              autoFill={autoFillServices}
              settings={settingsServices}
              search={{ service: searchService, assertContext }}
              cleaning={cleaningServices}
              macros={macroServices}
              presets={presetServices}
              tools={toolsFixture.tools}
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
syncSearchContext();
createRoot(document.getElementById("root")!).render(<Preview />);
