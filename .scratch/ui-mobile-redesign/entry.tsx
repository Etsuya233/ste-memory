import { createRoot } from "react-dom/client";
import { PanelShell, type PanelRuntime } from "../../src/ui/shell/panel-shell.tsx";
import { PanelModel } from "../../src/ui/shell/panel-model.ts";
import { DEFAULT_SETTINGS } from "../../src/features/settings/plugin-settings.ts";
import { SettingsService } from "../../src/features/settings/settings-service.ts";
import { fakeRuntime } from "./runtime-base.ts";

// Enforce the isolated preview boundary even for direct connection-test buttons.
window.fetch = async () => { throw new Error("隔离预览已禁用网络请求"); };

const now = "2026-10-23T06:00:00.000Z";
const stamp = { memorySpaceId: "space-1", createdAt: now, updatedAt: now };
let settings = structuredClone(DEFAULT_SETTINGS);
settings.embeddingConnection = { baseUrl: "https://preview.invalid/v1", apiKey: "", model: "local-preview", maxInputChars: 4000, timeoutSeconds: 10 };
let tables = [
  { id: "table-people", key: "people", name: "角色档案", description: "人物关系、经历与当前状态。", prompt: "按对话更新人物信息，保留已知事实。" },
  { id: "table-events", key: "events", name: "重要事件", description: "旅途中的转折与未完成的约定。", prompt: "记录时间、地点与事件的结果。" },
  { id: "table-places", key: "places", name: "地点与线索", description: "已发现的地点与待追踪的线索。", prompt: "" },
  { id: "table-notes", key: "notes", name: "长期约定与待办事项", description: "承诺、计划和下一次行动。", prompt: "" },
].map((table, position) => ({ ...stamp, ...table, enabled: true, position, displayStrategy: { type: "field", fieldId: `${table.id}-name` }, vectorIndex: { enabled: true, source: "automatic", updateMode: "manual", groups: [] } }));
let fields = tables.flatMap((table) => [
  { key: "name", name: "名称", type: "short_text", required: true },
  { key: "summary", name: "经历与关系", type: "long_text" },
  { key: "state", name: "当前状态", type: "single_select", options: ["同行", "失联", "已告别"] },
  { key: "date", name: "相识日期", type: "date" },
  { key: "trusted", name: "建立信任", type: "boolean" },
].map((field, position) => ({ ...stamp, options: [], required: false, enabled: true, prompt: "", referenceTableId: null, maxChars: null, valuePattern: null, valuePatternMessage: null, ...field, id: `${table.id}-${field.key}`, tableId: table.id, position })));
const people = ["林澈", "苏眠", "白塔守望者", "渡船人", "长名字的远行旅伴与北境调查员", "邮差", "钟楼学徒", "商队领队"];
let records = tables.flatMap((table, ti) => Array.from({ length: ti ? 3 : 23 }, (_, index) => people[index % people.length]).map((name, index) => ({
  ...stamp, id: `${table.id}-record-${index}`, tableId: table.id, displayText: name, payload: {
    [`${table.id}-name`]: name,
    [`${table.id}-summary`]: index === 0 ? "在旧港的雨夜相识。他曾帮助我们避开巡逻，也一直在寻找失踪的姐姐。约定在白塔钟声响起时再见。" : "在前往北境的旅途中相识，掌握一段尚未证实的线索。",
    [`${table.id}-state`]: index % 3 ? "同行" : "失联",
    [`${table.id}-date`]: "2026-10-12", [`${table.id}-trusted`]: index % 2 === 0,
  }, fieldEvidence: {}, source: index % 2 ? { type: "source", sourceTime: "雨夜", sourceLocation: "旧港" } : { type: "manual" }, revisionId: `revision-${index}`, revisionSource: index % 2 ? "agent" : "user",
})));
const history = new Map();
const listeners = new Set<() => void>();
let retrievalState: any = { epoch: 0, dataVersion: 0, status: "idle", result: null, error: null, indexUpdated: false, request: null, calls: 0, startedAt: null, elapsedMs: null };
const runtime = fakeRuntime() as any;
const unsupported = async () => { throw new Error("此预览未实现该能力"); };
runtime.settings = { read: () => settings, write: (value) => { settings = value; } };
runtime.settingsService = new SettingsService({ store: runtime.settings, syncToCurrentChat: async () => {}, refreshMemoryMacros: async () => {}, refreshAgentMacros: async () => {}, refreshMirror: async () => {}, refreshVectorIndex: async () => {}, writeChatScopeMacros: () => {} });
runtime.tables = {
  list: async () => [...tables],
  create: async (_space, input) => { const table = { ...stamp, ...input, id: crypto.randomUUID(), enabled: true, displayStrategy: null }; tables = [...tables, table]; return table; },
  update: async (_space, id, patch) => { tables = tables.map(table => table.id === id ? { ...table, ...patch, updatedAt: new Date().toISOString() } : table); return tables.find(table => table.id === id); },
  delete: async (_space, id) => { tables = tables.filter(table => table.id !== id); records = records.filter(record => record.tableId !== id); fields = fields.filter(field => field.tableId !== id); return true; },
};
runtime.fields = {
  list: async (_space, tableId) => fields.filter(field => field.tableId === tableId).sort((a, b) => a.position - b.position),
  create: async (_space, tableId, input) => { const field = { ...stamp, ...input, id: crypto.randomUUID(), tableId }; fields = [...fields, field]; return field; },
  update: async (_space, tableId, id, patch) => { fields = fields.map(field => field.id === id ? { ...field, ...patch } : field); return { field: fields.find(field => field.id === id), warnings: [] }; },
  delete: async (_space, tableId, id) => { fields = fields.filter(field => field.id !== id); return true; },
  setDisplayStrategy: async (_space, tableId, strategy) => { await runtime.tables.update(_space, tableId, { displayStrategy: strategy }); },
};
runtime.records = {
  list: async (_space, tableId, { page = 1, pageSize = 20, search = "" } = {}) => { const matches = records.filter(record => record.tableId === tableId && JSON.stringify(record.payload).includes(search)); return { records: matches.slice((page-1)*pageSize, page*pageSize), page, pageSize, total: matches.length, totalPages: Math.ceil(matches.length/pageSize) }; },
  find: async (_space, tableId, id) => records.find(record => record.id === id),
  previewDisplayText: async (_space, tableId, strategy, payload) => strategy?.type === "field" ? String(payload[strategy.fieldId] ?? "") : Object.values(payload).filter(value => typeof value === "string").join(" · "),
  listHistory: async (_space, { recordId }) => history.get(recordId) ?? [],
  create: async (_space, tableId, input) => { const record = { ...stamp, ...input, id: crypto.randomUUID(), tableId, displayText: String(input.payload[`${tableId}-name`] ?? "新记录"), fieldEvidence: {}, revisionId: crypto.randomUUID(), revisionSource: "user" }; records = [...records, record]; return record; },
  update: async (_space, tableId, id, input) => { const original = records.find(record => record.id === id); if (!original) throw new Error("记录不存在"); history.set(id, [{ ...original, archivedAt: now }, ...(history.get(id) ?? [])]); const record = { ...original, payload: { ...original.payload, ...input.patch }, revisionId: crypto.randomUUID(), updatedAt: new Date().toISOString() }; record.displayText = String(record.payload[`${tableId}-name`] ?? record.displayText); records = records.map(item => item.id === id ? record : item); return record; },
  delete: async (_space, tableId, id) => { records = records.filter(record => record.id !== id); return true; },
};
runtime.vector = {
  preview: async () => [], previewDraft: async () => [],
  previewDraftSummary: async () => ({ records: records.length, vectors: records.length, ready: records.length, pending: 0, empty: 0, invalid: 0, tooLong: 0, unavailable: 0 }),
  getTableSummary: async ({ tableId }) => ({ records: records.filter(record => record.tableId === tableId).length, ready: 3, stale: 1, errors: 0, empty: 0, queued: 0 }),
  getStatus: async () => ({ connection: "ready", error: null, tasks: [], vectors: [] }),
  listTasks: async () => ({ items: [], total: 0, queued: 0, running: 0 }), submit: async () => ({ created: 0, reused: 3, promoted: 0, skipped: 0 }), clear: async () => {}, cancel: async () => {}, cancelMany: async () => {}, retry: async () => {},
};
runtime.retrieval = {
  getState: () => retrievalState, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  ranges: async () => tables.map(table => ({ table, groups: [{ id: "automatic", name: "全部启用字段" }] })),
  search: async (request) => { const hits = records.slice(0, 3).map((record, index) => { const table = tables.find(table => table.id === record.tableId); const target = { table, record, groupId: "automatic", groupName: "全部启用字段", input: String(record.payload[`${table.id}-summary`]), fields: fields.filter(field => field.tableId === table.id) }; return { target, score: 0.92-index*0.1, groups: [{ target, score: 0.92-index*0.1, vector: { updatedAt: now } }] }; }); retrievalState = { ...retrievalState, status: "done", calls: 1, elapsedMs: 32, request, result: { request, message: "找到 3 条相关记忆", hits, profile: "本地预览 · 无网络请求", ranges: tables.map(table => ({ tableId: table.id, groupIds: ["automatic"] })), coverage: { checkedAt: now, records: records.length, expected: records.length, ready: records.length, empty: 0, missing: 0, stale: 0, invalid: 0, issues: [], taskStates: [] }, timing: { check: 8, remote: 0, sort: 24, total: 32 }, calls: 1 } }; listeners.forEach(listener => listener()); },
  cancel: () => {},
};
runtime.spaces = { list: async () => [runtime.manager.getStatus().space] };
runtime.st = { getMessageAt: () => ({ mes: "雨夜旧港的谈话。", name: "林澈", is_user: false }), chatMessageCount: () => 24, scrollToFloor: () => ({ kind: "jumped" }) };
runtime.backup.restoreSnapshot = unsupported;
runtime.backup.restoreSpace = unsupported;
const model = new PanelModel();
const initialTab = new URLSearchParams(location.search).get("tab");
if (initialTab) model.setTab(initialTab as any);
model.open();
window.__UI_PREVIEW__ = { model, runtime, getData: () => ({ tables, fields, records }) };
createRoot(document.getElementById("app")!).render(<PanelShell model={model} runtime={runtime as PanelRuntime} />);
