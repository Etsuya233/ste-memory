/** Deterministic UI fixture: no ST, database, model requests, or user data. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { RecordsApp } from "../../src/frontend/app.tsx";
import { FrontendPanel } from "../../src/frontend/host/panel.tsx";
import { RecordsWorkspace } from "../../src/frontend/pages/records-workspace.ts";
import type { RecordsContext } from "../../src/frontend/pages/records-workspace.ts";
import type { SpaceContextStatus } from "../../src/features/chat-binding/chat-space-manager.ts";
import type {
  MemoryField,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryTable,
} from "../../src/features/memory/index.ts";
import { MemoryRecordSaveError } from "../../src/features/memory/index.ts";
import { Button } from "../../src/ui/primitives/button.tsx";
import { NativeSelect } from "../../src/ui/primitives/native-select.tsx";

const date = "2026-10-28T09:00:00.000Z";
const contexts = {
  a: { chatKey: "char:1:bookshop", spaceId: "space-a", title: "雨后书店 · 爱丽丝" },
  b: { chatKey: "char:2:harbour", spaceId: "space-b", title: "旧港来信 · 林舟" },
} as unknown as Record<"a" | "b", RecordsContext>;
const tables = Object.values(contexts).flatMap((context) =>
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
const fields = tables.flatMap((table) =>
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
  async function switchChat(next: "a" | "b") {
    ready = false;
    setStatus(undefined);
    await workspace.setContext(null);
    current = next;
    ready = true;
    setStatus(activeStatus());
    await workspace.setContext(contexts[next]);
  }
  Object.assign(window, {
    frontendPreview: {
      switchChat,
      workspace,
      snapshot: () => structuredClone(records),
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
            <RecordsApp
              workspace={workspace}
              status={status}
              mirror={{ kind: "idle", lastWrittenAt: date, sizeBytes: 1000 }}
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
await workspace.setContext(contexts.a);
createRoot(document.getElementById("root")!).render(<Preview />);
