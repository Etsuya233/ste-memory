import {
  ChatSnapshotPersistence,
  snapshotSaveActions,
  type ChatFileTarget,
  type ChatSnapshotFileStore,
} from "../../src/features/chat-mirror/chat-snapshot-persistence.ts";
import type { MemorySpaceBackup } from "../../src/features/memory-snapshot/snapshot.ts";
import {
  remapMemoryTableDisplayStrategy,
  type MemoryField,
  type MemoryRecordPayload,
} from "../../src/features/memory/index.ts";

/** Preview editors share short field IDs; persisted snapshots require space-wide identities. */
function serializedPreviewSnapshot(snapshot: MemorySpaceBackup): MemorySpaceBackup {
  const fieldId = (tableId: string, id: string) => `${tableId}:${id}` as MemoryField["id"];
  const payload = (tableId: string, value: MemoryRecordPayload) =>
    Object.fromEntries(Object.entries(value).map(([id, value]) => [fieldId(tableId, id), value]));
  return {
    ...snapshot,
    tables: snapshot.tables.map((table) => {
      const ids = new Map(
        snapshot.fields
          .filter((field) => field.tableId === table.id)
          .map((field) => [field.id, fieldId(table.id, field.id)]),
      );
      return {
        ...table,
        displayStrategy: remapMemoryTableDisplayStrategy(table.displayStrategy, ids),
        ...(table.vectorIndex
          ? {
              vectorIndex: {
                ...table.vectorIndex,
                groups: table.vectorIndex.groups.map((group) => ({
                  ...group,
                  fieldIds: group.fieldIds.map((id) => fieldId(table.id, id)),
                })),
                ...(table.vectorIndex.presetGroups
                  ? {
                      presetGroups: table.vectorIndex.presetGroups.map((group) => ({
                        ...group,
                        fieldIds: group.fieldIds.map((id) => fieldId(table.id, id)),
                      })),
                    }
                  : {}),
              },
            }
          : {}),
      };
    }),
    fields: snapshot.fields.map((field) => ({ ...field, id: fieldId(field.tableId, field.id) })),
    records: snapshot.records.map((record) => ({
      ...record,
      payload: payload(record.tableId, record.payload),
      fieldEvidence: Object.fromEntries(
        Object.entries(record.fieldEvidence).map(([id, evidence]) => [
          fieldId(record.tableId, id),
          evidence,
        ]),
      ),
    })),
    history: snapshot.history.map((record) => ({
      ...record,
      payload: payload(record.tableId, record.payload),
      fieldEvidence: Object.fromEntries(
        Object.entries(record.fieldEvidence).map(([id, evidence]) => [
          fieldId(record.tableId, id),
          evidence,
        ]),
      ),
    })),
  };
}

interface SaveAttempt {
  delay: number;
  error: string | null;
}

/** Uses the production persistence lifecycle with an isolated in-memory host/file adapter. */
export function createSnapshotSaveFixture(
  currentIdentity: () => string,
  readSnapshot: (identity: string) => MemorySpaceBackup,
) {
  const files = new Map<string, Record<string, unknown>>();
  const attempts = new Map<string, SaveAttempt>();
  let generation = 0;
  let delay = 0;
  let nextError: string | null = null;
  let beforeStart: { message: string; delay: number } | null = null;
  let syncCalls = 0;
  const counts = { submit: 0, verify: 0, confirm: 0, cleanup: 0 };
  const history: { identity: string; kind: string; operationId?: number }[] = [];
  function assertActive(target: ChatFileTarget) {
    if (currentIdentity() !== target.identity) {
      throw new Error("对话已切换，请返回原对话后重试");
    }
  }
  const store: ChatSnapshotFileStore = {
    read: async (target) => files.get(target.identity)?.steMemoryMirror,
    restore: (target, mirror, binding) => {
      assertActive(target);
      files.set(target.identity, structuredClone({ steMemory: binding, steMemoryMirror: mirror }));
    },
    submit: async (target, mirror, binding) => {
      assertActive(target);
      counts.submit++;
      const attempt = { delay, error: nextError };
      delay = 0;
      nextError = null;
      attempts.set(target.identity, attempt);
      files.set(target.identity, structuredClone({ steMemory: binding, steMemoryMirror: mirror }));
      const status = persistence.getStatus(target.identity);
      if (attempt.error && status.kind !== "idle" && status.operation === "update") {
        throw new Error(attempt.error);
      }
    },
    verify: async (target) => {
      counts.verify++;
      const attempt = attempts.get(target.identity)!;
      if (attempt.delay) {
        await new Promise((done) => setTimeout(done, attempt.delay));
      }
      if (attempt.error) {
        throw new Error(attempt.error);
      }
      return structuredClone(files.get(target.identity)!);
    },
  };
  const persistence = new ChatSnapshotPersistence(store, () => "frontend-preview");
  persistence.onStatusChange((status) => {
    if (status.kind !== "idle") {
      history.push({
        identity: status.identity,
        kind: status.kind,
        operationId: status.operationId,
      });
    }
  });
  function capture() {
    const identity = currentIdentity();
    const snapshot = serializedPreviewSnapshot(readSnapshot(identity));
    const target: ChatFileTarget = { kind: "group", identity, chatId: identity };
    const binding = { version: 2 as const, spaceId: snapshot.space.id, chatIdentity: identity };
    return { target, snapshot, binding };
  }
  async function forceSync() {
    const { target, snapshot, binding } = capture();
    const token = generation;
    const assertCurrent = () => {
      assertActive(target);
      if (token !== generation) {
        throw new Error("对话已切换，请返回原对话后重试");
      }
    };
    const rejection = beforeStart;
    beforeStart = null;
    if (rejection) {
      await new Promise((done) => setTimeout(done, rejection.delay));
      assertCurrent();
      throw new Error(rejection.message);
    }
    syncCalls++;
    await persistence.forceSync(target, binding, snapshot, assertCurrent);
  }
  async function saveCommitted() {
    const { target, snapshot, binding } = capture();
    await persistence.saveCommitted(target, binding, snapshot);
  }
  async function replace(options: { confirmDelay?: number; cleanupFailures?: number } = {}) {
    const { target, snapshot, binding } = capture();
    let failures = options.cleanupFailures ?? 0;
    await persistence.replace(
      target,
      snapshot,
      binding,
      async () => {
        counts.confirm++;
        if (options.confirmDelay) {
          await new Promise((done) => setTimeout(done, options.confirmDelay));
        }
      },
      async () => {
        counts.cleanup++;
        if (failures-- > 0) {
          throw new Error("预览旧向量清理失败");
        }
      },
    );
  }
  return {
    subscribe: (listener: () => void) => persistence.onStatusChange(listener),
    getSnapshot: () => persistence.getStatus(currentIdentity()),
    writeBlockReason: () => {
      const identity = currentIdentity();
      if (persistence.hasPendingReplacement(identity)) {
        return "候选空间尚待核验，请先重试保存";
      }
      const status = persistence.getStatus(identity);
      if (
        status.kind !== "idle" &&
        status.operation === "force-sync" &&
        (status.kind === "queued" ||
          status.kind === "saving" ||
          status.kind === "verifying" ||
          status.kind === "confirming")
      ) {
        return "正在强制同步，请等待核验完成";
      }
      return undefined;
    },
    hasPendingWrites: () => persistence.hasPendingWrites(),
    forceSync,
    saveCommitted,
    replace,
    retry: () => {
      const identity = currentIdentity();
      const actions = snapshotSaveActions(persistence.getStatus(identity), true);
      if (!actions.canRetry) {
        throw new Error(actions.disabledReason ?? "当前没有可重试的保存操作");
      }
      return actions.recovery === "retry-cleanup"
        ? persistence.retryCleanup(identity)
        : forceSync();
    },
    showFailure: async (
      message = "preview file failure",
      operation: "update" | "replacement" = "update",
    ) => {
      nextError = message;
      try {
        await (operation === "replacement" ? replace() : saveCommitted());
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.includes(message)) {
          throw cause;
        }
      }
    },
    delayNext: (ms: number) => {
      delay = ms;
    },
    failNext: (message: string) => {
      nextError = message;
    },
    syncCalls: () => syncCalls,
    metrics: () => structuredClone({ ...counts, history }),
    failBeforeStart: (message: string, delay = 0) => {
      beforeStart = { message, delay };
    },
    enterChat: () => {
      const { target, snapshot, binding } = capture();
      const candidate = persistence.current(target.identity);
      if (candidate && persistence.hasPendingReplacement(target.identity)) {
        persistence.remember(target, candidate.snapshot, candidate.binding);
        persistence.restoreCandidate(target.identity);
      } else {
        persistence.remember(target, snapshot, binding);
      }
    },
    leaveChat: () => {
      generation++;
      persistence.release(currentIdentity());
    },
  };
}
