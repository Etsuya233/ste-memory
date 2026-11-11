import type { SettingsTools } from "../../src/frontend/pages/settings/SettingsPage.tsx";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION } from "../../src/features/memory-snapshot/snapshot.ts";
import type { MemorySpaceBackupLedgerEntry } from "../../src/features/memory-snapshot/snapshot.ts";
import type { RecordsContext } from "../../src/frontend/pages/records-workspace.ts";
import type {
  MemoryTable,
  MemoryField,
  MemoryRecord,
  MemoryEvidence,
} from "../../src/features/memory/index.ts";
import type { MemoryBackupData } from "../../src/features/backup/backup-file.ts";
import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "../../src/features/backup/backup-codec.ts";
import { historyExportFilename } from "../../src/features/backup/space-transfer.ts";
import { downloadTextFile } from "../../src/infrastructure/browser/download.ts";
import { QueryChatStore } from "../../src/features/query-chat/query-chat-state.ts";
import { QueryChatService } from "../../src/features/query-chat/query-chat-service.ts";
import type { QueryChatHistoryMessage } from "../../src/features/query-chat/query-chat-state.ts";
import type {
  MemoryProposalPorts,
  MemoryRecordService,
  MemorySpaceReader,
} from "../../src/features/memory/index.ts";
import { SteMemoryDatabase } from "../../src/infrastructure/indexeddb/database.ts";
import { IndexedDbAssistantSessions } from "../../src/infrastructure/indexeddb/assistant-session-repository.ts";
import {
  assistantMessage,
  fakeModel,
  lastToolResult,
  scriptedDeltaStreamFn,
  textMessage,
  thinkingMessage,
  toolCallMessage,
} from "../../src/features/fill-tasks/stream-fn-support.ts";
import type { LogEntry } from "../../src/features/logging/log.ts";
import {
  decodeHistoryVersion,
  encodeHistoryVersion,
  type HistorySource,
} from "../../src/features/memory-history/history.ts";
import type { MaintenanceContext } from "../../src/frontend/pages/maintenance/maintenance-page.tsx";

interface FixtureData {
  tables: MemoryTable[];
  fields: MemoryField[];
  records: MemoryRecord[];
}
export function createToolsFixture(options: {
  contexts: readonly RecordsContext[];
  current: () => RecordsContext | null;
  read: () => FixtureData;
  write: (data: FixtureData) => void;
  changed: () => Promise<void>;
  assertContext: (context: RecordsContext) => void;
  reader: MemorySpaceReader;
  ports: MemoryProposalPorts;
  recordWriter: Pick<MemoryRecordService, "commitProposal">;
  readLedger: (spaceId: string) => readonly MemorySpaceBackupLedgerEntry[];
  writeLedger: (spaceId: string, ledger: readonly MemorySpaceBackupLedgerEntry[]) => void;
  historyLimit: () => number;
}) {
  const queryStore = new QueryChatStore(
    new IndexedDbAssistantSessions(new SteMemoryDatabase("ste-memory-assistant-preview")),
  );
  let queryDelay = 30;
  let sqlDelay = 0;
  let queryFailure = false;
  const queryInputs: (readonly QueryChatHistoryMessage[])[] = [];
  const versions = new Map<string, Awaited<ReturnType<typeof encodeHistoryVersion>>>();
  function historyContext(target: MaintenanceContext) {
    const current = options.current();
    if (current?.chatKey !== target.chatKey || current.spaceId !== target.spaceId) {
      throw new Error("当前对话已切换或记忆空间已变化");
    }
    return current;
  }
  function historyEntry(target: MaintenanceContext, id: string) {
    historyContext(target);
    const entry = versions.get(id);
    if (entry?.version.chatKey !== target.chatKey) {
      throw new Error("历史版本不存在");
    }
    return entry;
  }
  async function captureVersion(target: MaintenanceContext, source: HistorySource, name?: string) {
    const current = historyContext(target);
    const unit = snapshot().spaces.find((space) => space.space.id === current.spaceId)!;
    const entry = await encodeHistoryVersion(
      current.chatKey,
      crypto.randomUUID(),
      new Date().toISOString(),
      source,
      unit,
      name,
    );
    historyContext(target);
    versions.set(entry.version.id, entry);
  }
  let historyTrimFailure = false;
  function trimHistory(chatKey: string, limit: number) {
    const automatic = [...versions.values()].filter(
      ({ version }) => version.chatKey === chatKey && version.source !== "manual",
    );
    for (const { version } of automatic.slice(0, Math.max(0, automatic.length - limit))) {
      versions.delete(version.id);
    }
  }
  let logs: LogEntry[] = Array.from({ length: 38 }, (_, i) => ({
    id: i + 1,
    type: ["fill", "vector", "query"][i % 3]!,
    key: i % 5 === 0 ? "space-a-running-fill" : `preview-task-${i % 4}`,
    level: (["info", "warn", "error"] as const)[i % 3]!,
    text: `${["填表批次完成", "向量索引更新", "记忆问答失败"][i % 3]}\n第 ${i + 1} 条预览日志`,
    createdAt: new Date(Date.UTC(2026, 9, 28, 18, 0, 0) - i * 7 * 60 * 1000).toISOString(),
  })).reverse();
  function snapshot(): MemoryBackupData {
    const data = options.read();
    return {
      spaces: options.contexts.map((context) => {
        const ownTables = data.tables.filter((table) => table.memorySpaceId === context.spaceId);
        const ownFields = data.fields.filter((field) => field.memorySpaceId === context.spaceId);
        const fieldId = (tableId: string, id: string) =>
          (id.startsWith(`${tableId}:`) ? id : `${tableId}:${id}`) as MemoryField["id"];
        const ownRecords = data.records
          .filter((record) => record.memorySpaceId === context.spaceId)
          .map((record) => ({
            ...record,
            payload: Object.fromEntries(
              Object.entries(record.payload).map(([id, value]) => [
                fieldId(record.tableId, id),
                value,
              ]),
            ),
            fieldEvidence: Object.fromEntries(
              Object.entries(record.fieldEvidence).map(([id, entries]) => [
                fieldId(record.tableId, id),
                entries.map((entry) => ({
                  ...entry,
                  evidence_id: (entry.evidence_id.startsWith(`${context.spaceId}:`)
                    ? entry.evidence_id
                    : `${context.spaceId}:${entry.evidence_id}`) as MemoryEvidence["evidence_id"],
                })),
              ]),
            ),
          }));
        const evidence = new Map<string, MemoryEvidence>();
        for (const record of ownRecords) {
          for (const entries of Object.values(record.fieldEvidence)) {
            for (const entry of entries) {
              evidence.set(entry.evidence_id, entry);
            }
          }
        }
        return {
          schemaVersion: MEMORY_SNAPSHOT_SCHEMA_VERSION,
          floorLedger: options.readLedger(context.spaceId),
          space: {
            macros: [],
            id: context.spaceId,
            stableId: context.spaceId,
            name: context.title,
            initializationSource: null,
            createdAt: "",
            updatedAt: "",
          },
          tables: ownTables.map((table) => ({
            ...table,
            displayStrategy:
              table.displayStrategy?.type === "field"
                ? {
                    ...table.displayStrategy,
                    fieldId: fieldId(table.id, table.displayStrategy.fieldId),
                  }
                : table.displayStrategy,
          })),
          fields: ownFields.map((field) => ({ ...field, id: fieldId(field.tableId, field.id) })),
          records: ownRecords,
          history: [],
          evidence: [...evidence.values()],
        };
      }),
    };
  }
  const tools: SettingsTools = {
    logs: {
      recent: async (limit) => structuredClone(logs.slice(0, limit)),
      byKey: async (key, limit) =>
        structuredClone(logs.filter((entry) => entry.key === key).slice(0, limit)),
      clearAll: async () => {
        logs = [];
      },
    },
    maintenance: {
      currentContext: options.current,
      history: {
        list: async (target) => {
          historyContext(target);
          return [...versions.values()]
            .filter(({ version }) => version.chatKey === target.chatKey)
            .reverse()
            .map(({ version }) => version);
        },
        failure: () => undefined,
        retryAutomatic: async () => {
          throw new Error("当前没有待重试的自动版本");
        },
        save: (target, name) => captureVersion(target, "manual", name),
        rename: async (target, id, name) => {
          const entry = historyEntry(target, id);
          versions.set(id, { ...entry, version: { ...entry.version, name } });
        },
        remove: async (target, id) => {
          historyEntry(target, id);
          versions.delete(id);
        },
        exportBackup: async (target, id) => {
          const { version, payload } = historyEntry(target, id);
          const unit = await decodeHistoryVersion(version, payload);
          historyContext(target);
          const file = createBackupFile({ spaces: [unit] }, "preview", version.createdAt);
          downloadTextFile(
            serializeBackupFile(file),
            historyExportFilename(target.title, version.name, version.createdAt),
          );
          return true;
        },
        prepareRestore: async (target, id) => {
          const { version, payload } = historyEntry(target, id);
          const unit = await decodeHistoryVersion(version, payload);
          historyContext(target);
          const file = createBackupFile({ spaces: [unit] }, "preview", version.createdAt);
          const preview = await tools.maintenance.previewImport(serializeBackupFile(file));
          return {
            ...preview,
            confirmMessage: `${preview.confirmMessage} 旧空间的任务、向量及 Agent 会话按空间替换规则停止或清理。`,
            apply: async () => {
              historyEntry(target, id);
              await captureVersion(target, "before-restore");
              try {
                return await preview.apply();
              } finally {
                trimHistory(target.chatKey, options.historyLimit());
              }
            },
          };
        },
      },
      exportBackup: async () => {
        const context = options.current();
        if (!context) {
          throw new Error("请先打开对话");
        }
        const data = {
          spaces: snapshot().spaces.filter((unit) => unit.space.id === context.spaceId),
        };
        downloadTextFile(
          serializeBackupFile(createBackupFile(data, "preview", new Date().toISOString())),
          "ste-memory-preview-backup.json",
        );
        return true;
      },
      previewImport: async (text) => {
        const file = parseBackupFile(text);
        const context = options.current();
        if (!context) {
          throw new Error("请先打开对话");
        }
        if (file.data.spaces.length !== 1) {
          throw new Error("导入文件必须只包含一个记忆空间");
        }
        const source = file.data.spaces[0]!;
        // 独立预览保持对话身份，导入的数据归属当前对话空间。
        const units = [
          {
            ...source,
            space: { ...source.space, id: context.spaceId },
            tables: source.tables.map((table) => ({ ...table, memorySpaceId: context.spaceId })),
            fields: source.fields.map((field) => ({ ...field, memorySpaceId: context.spaceId })),
            records: source.records.map((record) => ({
              ...record,
              memorySpaceId: context.spaceId,
            })),
          },
        ];
        let applied = false;
        return {
          recordCount: units.reduce((n, u) => n + u.records.length, 0),
          summary: units.map((u) => u.space.name).join("、"),
          confirmMessage: `替换当前对话「${context.title}」的记忆空间。`,
          apply: async () => {
            if (applied) {
              throw new Error("该预览已执行");
            }
            options.assertContext(context);
            const current = options.read();
            const ids = new Set(units.map((u) => u.space.id));
            options.write({
              tables: [
                ...current.tables.filter((t) => !ids.has(t.memorySpaceId)),
                ...units.flatMap((u) => u.tables),
              ],
              fields: [
                ...current.fields.filter((f) => !ids.has(f.memorySpaceId)),
                ...units.flatMap((u) => u.fields),
              ],
              records: [
                ...current.records.filter((r) => !ids.has(r.memorySpaceId)),
                ...units.flatMap((u) => u.records),
              ],
            });
            applied = true;
            options.writeLedger(context.spaceId, source.floorLedger);
            for (const id of ids) {
              await queryStore.clearSpaceHistory(id);
            }
            await options.changed();
            return { kind: "done", message: "当前对话的记忆空间已替换。" };
          },
        };
      },
      clearRecords: async (context) => {
        if (!context.spaceId) {
          throw new Error("当前空间未加载，无法清除记录");
        }
        options.assertContext({ ...context, spaceId: context.spaceId });
        const data = options.read();
        options.write({
          ...data,
          records: data.records.filter((record) => record.memorySpaceId !== context.spaceId),
        });
        options.writeLedger(context.spaceId, []);
        await queryStore.clearSpaceHistory(context.spaceId);
        await options.changed();
        return { kind: "done", message: "当前空间记录已清除。" };
      },
    },
    query: {
      store: queryStore,
      assertContext: options.assertContext,
      onDataChanged: async (context) => {
        options.assertContext(context);
        await options.changed();
      },
      service: new QueryChatService({
        store: queryStore,
        reader: options.reader,
        ports: options.ports,
        recordWriter: options.recordWriter,
        getCurrentContext: () => options.current() ?? undefined,
        createLlm: () => ({
          model: fakeModel(),
          streamFn: async (model, context, requestOptions) => {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, queryDelay);
              requestOptions?.signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
            if (requestOptions?.signal?.aborted) {
              return scriptedDeltaStreamFn(() => assistantMessage([], "aborted", "已取消"))(
                model,
                context,
                requestOptions,
              );
            }
            if (queryFailure) {
              queryFailure = false;
              return scriptedDeltaStreamFn(() =>
                assistantMessage([], "error", "预览模拟：连接失败"),
              )(model, context, requestOptions);
            }
            return scriptedDeltaStreamFn((current) => {
              const last = current.messages.at(-1);
              if (last?.role === "user") {
                const text =
                  typeof last.content === "string"
                    ? last.content
                    : last.content
                        .filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("");
                queryInputs.push([{ role: "user", text }]);
                if (text.includes("新增")) {
                  return assistantMessage(
                    [
                      toolCallMessage(crypto.randomUUID(), "mutate", {
                        op: "create",
                        table: "table_0",
                        patch: { name: "预览新增人物" },
                      }),
                    ],
                    "toolUse",
                  );
                }
                return assistantMessage(
                  [toolCallMessage(crypto.randomUUID(), "query_records", { table: "table_0" })],
                  "toolUse",
                );
              }
              if (lastToolResult(current)) {
                return assistantMessage(
                  [
                    thinkingMessage("预览模拟：检查记忆…"),
                    textMessage("预览模拟：**爱丽丝**在雨后书店寻找旧港手记。请查看待提交修改。"),
                  ],
                  "stop",
                );
              }
              return assistantMessage([textMessage("查询完成")], "stop");
            })(model, context, requestOptions);
          },
        }),
      }),
    },
    sql: {
      assertContext: options.assertContext,
      onExecuted: async () => options.changed(),
      console: {
        schema: async (spaceId) =>
          options
            .read()
            .tables.filter((table) => table.memorySpaceId === spaceId)
            .map((table) => ({
              name: table.key,
              type: "table",
              sql: null,
              columns: options
                .read()
                .fields.filter((field) => field.tableId === table.id)
                .map((field) => ({ name: field.key, type: field.type })),
            })),
        execute: async (_spaceId, sql, signal) => {
          if (sqlDelay) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, sqlDelay);
              signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  reject(new DOMException("SQL已取消", "AbortError"));
                },
                { once: true },
              );
            });
          }
          signal?.throwIfAborted();
          if (sql.trim().toLowerCase() === "invalid") {
            throw new Error("预览模拟：SQL语法错误");
          }
          return {
            results: [{ columns: ["name", "notes"], rows: [["爱丽丝", "预览模拟 SQL 结果"]] }],
            changes: 0,
            transactionOpen: false,
            elapsedMs: 1,
          };
        },
      },
    },
  };
  return {
    tools,
    trimHistory: async (limit: number) => {
      if (historyTrimFailure) {
        historyTrimFailure = false;
        throw new Error("预览：历史存储暂不可用");
      }
      for (const context of options.contexts) {
        trimHistory(context.chatKey, limit);
      }
    },
    failNextHistoryTrim: () => {
      historyTrimFailure = true;
    },
    setLogText: (id: number, text: string) => {
      logs = logs.map((entry) => (entry.id === id ? { ...entry, text } : entry));
    },
    queryStore,
    delaySQL: (ms: number) => {
      sqlDelay = ms;
    },
    queryInputs: () => structuredClone(queryInputs),
    delayQuery: (ms: number) => {
      queryDelay = ms;
    },
    failNextQuery: () => {
      queryFailure = true;
    },
  };
}
