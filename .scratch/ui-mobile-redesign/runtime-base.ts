import { SettingsService } from "../../src/features/settings/settings-service.ts";
import { DEFAULT_SETTINGS } from "../../src/features/settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../../src/features/chat-binding/chat-space-manager.ts";
import type { MemorySpaceId } from "../../src/features/memory/index.ts";
import type { PanelRuntime } from "../../src/ui/shell/panel-shell.tsx";
function activeStatus(): SpaceContextStatus {
  return {
    kind: "active",
    binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
    space: {
      id: "space-1" as MemorySpaceId,
      name: "爱丽丝 - story",
      initializationSource: null,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    created: false,
    restored: false,
  };
}

export function fakeRuntime(overrides: Partial<PanelRuntime> = {}): PanelRuntime {
  const status = activeStatus();
  const mirrorStatus = { kind: "idle" as const, lastWrittenAt: undefined, sizeBytes: undefined };
  return {
    vector: {} as PanelRuntime["vector"],
    retrieval: {
      getState: () => ({
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
      }),
      subscribe: () => () => {},
      ranges: async () => [],
      search: async () => {},
      cancel: () => {},
    },
    spaces: { list: async () => [] },
    manager: {
      getStatus: () => status,
      onStatusChange: () => () => {},
      syncToCurrentChat: async () => activeStatus(),
      resolveBranch: async () => activeStatus(),
      importSpace: async () => activeStatus(),
    },
    tables: {
      list: async () => [],
      update: async () => undefined,
      create: async () => undefined,
      delete: async () => false,
    },
    fields: {
      list: async () => [],
      update: async () => undefined,
      create: async () => undefined,
      delete: async () => false,
      setDisplayStrategy: async () => undefined,
    },
    records: {
      list: async () => undefined,
      previewDisplayText: async () => "",
      create: async () => undefined,
      update: async () => undefined,
      delete: async () => false,
      find: async () => undefined,
      listHistory: async () => [],
    },
    st: {
      scrollToFloor: () => ({ kind: "jumped" }) as const,
      getMessageAt: () => undefined,
      chatMessageCount: () => 0,
    },
    settingsService: new SettingsService({
      store: { read: () => DEFAULT_SETTINGS, write: () => {} },
      syncToCurrentChat: async () => {},
      refreshMemoryMacros: async () => {},
      refreshAgentMacros: async () => {},
      refreshMirror: async () => {},
      refreshVectorIndex: async () => {},
      writeChatScopeMacros: () => {},
    }),
    settings: {
      read: () => DEFAULT_SETTINGS,
      write: () => {},
    },
    backup: {
      loadSnapshot: async () => ({ spaces: [] }),
      restoreSnapshot: async () => {},
      restoreSpace: async () => {},
      cloneSpaceFromUnit: async () => "new-space" as MemorySpaceId,
    },
    mirror: {
      flushRebuiltSpace: async () => {},
      getStatus: () => mirrorStatus,
      onStatusChange: () => () => {},
      kick: async () => {},
    },
    tasks: {
      submit: async () => ({}) as never,
      submitInit: async () => ({}) as never,
      cancel: async () => ({}) as never,
      retry: async () => ({}) as never,
      activeTask: async () => undefined,
      recentTasks: async () => [],
      ledgerStatuses: async () => [],
      markFloorStatuses: async () => undefined,
    },
    spaceMaintenance: { clearRecords: async () => false },
    presetApply: {
      assertCurrentChat: () => {},
      stopSpaceWrites: async () => undefined,
      applyPreset: async () => ({ kind: "applied" as const }),
    },
    queryChat: {
      run: async () => ({
        stopReason: "stop" as const,
        errorMessage: undefined,
        answer: "",
        commit: undefined,
      }),
    },
    logs: {
      byKey: async () => [],
      recent: async () => [],
      clearAll: async () => {},
    },
    macro: {
      kick: async () => {},
    },
    agentMacro: {
      kick: async () => {},
    },
    presetPreview: {
      getPromptSnapshot: () => ({
        names: { user: "小明", char: "爱丽丝" },
        charCard: "",
        userCard: "",
        worldbookText: "",
        msgText: "",
      }),
      readSpaceId: () => undefined,
      readDigest: async () => ({ memorySpaceId: "space-1" as never, tables: [] }),
      scanWorldbook: async () => ({ text: "", status: "scanned" as const }),
    },
    macroOverview: () => [],
    cleaning: {
      readSelection: () => undefined,
      writeSelection: () => {},
      readStRegexEntries: () => [],
      readRecentMessages: () => [],
      readChatScopeMacros: () => [],
      writeChatScopeMacros: () => {},
    },
    version: "0.1.0",
    ...overrides,
  };
}
