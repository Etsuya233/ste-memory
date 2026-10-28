/** In-memory records acceptance fixture. No SillyTavern, IndexedDB, network, or user data. */
import { useLayoutEffect, useState } from "react";
import { PrimitivesProvider } from "../../src/ui/primitives/provider.tsx";
import { createRoot } from "react-dom/client";
import { RecordsTab } from "../../src/ui/memory/record-view.tsx";
import { PageLayout, PageHeaderActions } from "../../src/ui/shell/page-layout.tsx";
import { PanelBar } from "../../src/ui/shell/panel-bar.tsx";
import { themeAttributes } from "../../src/ui/kit/theme.tsx";
import { DEFAULT_SETTINGS } from "../../src/features/settings/plugin-settings.ts";
import type { PanelRuntime } from "../../src/ui/shell/panel-shell.tsx";
import type { SpaceContextStatus } from "../../src/features/chat-binding/chat-space-manager.ts";
import type { MemoryRecord, MemoryRecordHistory } from "../../src/features/memory/index.ts";

const date = "2026-10-27T10:00:00.000Z";
const tables = ["人物", "地点", "空表"].map((name, position) => ({
  id: `table-${position}`,
  memorySpaceId: "preview",
  key: `table_${position}`,
  name,
  description: "独立验收数据",
  prompt: "",
  enabled: true,
  position,
  displayStrategy: { type: "field", fieldId: "name" },
  createdAt: date,
  updatedAt: date,
}));
const fields = [
  { id: "name", name: "名称", type: "short_text", required: true },
  { id: "notes", name: "描述", type: "long_text", required: false },
  { id: "active", name: "活跃", type: "boolean", required: false },
  {
    id: "role",
    name: "角色",
    type: "single_select",
    required: false,
    options: ["旅人", "学者", "守卫"],
  },
  {
    id: "tags",
    name: "标签",
    type: "multi_select",
    required: false,
    options: ["朋友", "同伴", "陌生人"],
  },
  { id: "legacy", name: "旧备注", type: "short_text", required: false, enabled: false },
].map((field, position) => ({
  memorySpaceId: "preview",
  tableId: "table-0",
  key: field.id,
  prompt: "",
  enabled: true,
  position,
  options: [],
  referenceTableId: null,
  maxChars: null,
  valuePattern: null,
  valuePatternMessage: null,
  createdAt: date,
  updatedAt: date,
  ...field,
}));
let records = Array.from({ length: 23 }, (_, i) => ({
  id: `record-${i}`,
  memorySpaceId: "preview",
  tableId: i === 22 ? "table-1" : "table-0",
  payload: {
    name: i === 0 ? "爱丽丝" : i === 22 ? "旧港口" : `旅人 ${String(i).padStart(2, "0")}`,
    notes: "在雨后的街角交换了名字，约定下次带上那本书。",
    active: true,
    role: "旅人",
    tags: ["朋友"],
    legacy: "保留的历史字段",
  },
  fieldEvidence:
    i === 0
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
  displayText: i === 0 ? "爱丽丝" : i === 22 ? "旧港口" : `旅人 ${String(i).padStart(2, "0")}`,
  source: { type: "manual" },
  revisionId: `revision-${i}`,
  revisionSource: "user",
  createdAt: date,
  updatedAt: date,
})) as unknown as MemoryRecord[];
const history: MemoryRecordHistory[] = [];
let serial = 100;
const events: string[] = [];
const status = {
  kind: "active",
  binding: { version: 1, spaceId: "preview" },
  space: {
    id: "preview",
    name: "雨后书店",
    initializationSource: null,
    createdAt: date,
    updatedAt: date,
  },
  created: false,
  restored: false,
} as SpaceContextStatus;
const runtime = {
  tables: { list: async () => tables },
  fields: {
    list: async (_space: string, table: string) =>
      fields.map((field) => ({ ...field, tableId: table })),
  },
  records: {
    list: async (
      _space: string,
      table: string,
      options = { page: 1, pageSize: 10 } as {
        page: number;
        pageSize: number;
        search?: string;
        order?: { fieldId: string; direction: string };
      },
    ) => {
      let result = records.filter(
        (record) =>
          record.tableId === table &&
          (!options.search || JSON.stringify(record.payload).includes(options.search)),
      );
      if (options.order && !options.order.fieldId.startsWith("$")) {
        const { fieldId, direction } = options.order;
        result = [...result].sort(
          (a, b) =>
            String(a.payload[fieldId]).localeCompare(String(b.payload[fieldId])) *
            (direction === "asc" ? 1 : -1),
        );
      }
      return {
        records: result.slice(
          (options.page - 1) * options.pageSize,
          options.page * options.pageSize,
        ),
        total: result.length,
        totalPages: Math.ceil(result.length / options.pageSize),
        ...options,
      };
    },
    find: async (_space: string, _table: string, id: string) =>
      records.find((record) => record.id === id),
    previewDisplayText: async (
      _space: string,
      _table: string,
      _strategy: unknown,
      payload: Record<string, unknown>,
    ) => String(payload?.name ?? ""),
    listHistory: async (_space: string, query: { recordId: string }) =>
      history.filter((item) => item.recordId === query.recordId),
    create: async (_space: string, table: string, input: { payload: MemoryRecord["payload"] }) => {
      const record = {
        ...records[0],
        id: `record-${++serial}`,
        tableId: table,
        payload: input.payload,
        fieldEvidence: {},
        displayText: String(input.payload.name),
        revisionId: `revision-${serial}`,
      } as MemoryRecord;
      records.push(record);
      events.push("create");
      return record;
    },
    update: async (
      _space: string,
      _table: string,
      id: string,
      input: { patch: MemoryRecord["payload"] },
    ) => {
      const previous = records.find((record) => record.id === id)!;
      history.push({
        ...previous,
        id: `history-${++serial}`,
        recordId: id,
        archivedAt: date,
        previousRevisionId: previous.revisionId,
        previousRevisionSource: previous.revisionSource,
      } as MemoryRecordHistory);
      const payload = { ...previous.payload, ...input.patch };
      const record = {
        ...previous,
        payload,
        displayText: String(payload.name),
        revisionId: `revision-${serial}`,
      } as MemoryRecord;
      records = records.map((item) => (item.id === id ? record : item));
      events.push("update");
      return record;
    },
    delete: async (_space: string, _table: string, id: string) => {
      records = records.filter((record) => record.id !== id);
      events.push("delete");
      return true;
    },
  },
  vector: {
    preview: async () => [],
    getStatus: async () => ({ tasks: [], vectors: [], connection: "ready" }),
  },
  macro: { kick: async () => {} },
  st: {
    scrollToFloor: (floor: number) => {
      events.push(`jump:${floor}`);
      return { kind: "jumped" };
    },
    getMessageAt: (floor: number) => ({
      floor,
      content: "雨后的街角，她说：我是爱丽丝。",
      name: "爱丽丝",
      isUser: false,
    }),
    chatMessageCount: () => 20,
  },
} as unknown as PanelRuntime;
Object.assign(window, {
  recordsPreview: { snapshot: () => structuredClone(records), events, history },
});
const dark = new URLSearchParams(location.search).has("dark");
function Preview() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    container?.showPopover();
  }, [container]);
  return (
    <PrimitivesProvider container={container}>
      <aside
        ref={setContainer}
        popover="manual"
        id="stm-panel"
        className="ui-theme stm-panel stm-panel--open stm-luma preview-panel"
        {...themeAttributes({
          appearance: "classic",
          tone: dark ? "dark" : "light",
          background: dark ? "#18181b" : "#fafafa",
          accent: "#52525b",
          accentForeground: "#fff",
        })}
      >
        <PageLayout
          header={
            <PanelBar
              title="记录"
              subtitle="雨后书店 · 本地演示"
              trailing={<PageHeaderActions />}
            />
          }
          contentClassName="stm-panel-body"
        >
          <RecordsTab
            runtime={runtime}
            status={status}
            settings={{ ...DEFAULT_SETTINGS, enabled: true }}
            dataVersion={0}
          />
        </PageLayout>
      </aside>
    </PrimitivesProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
