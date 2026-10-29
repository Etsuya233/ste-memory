import {
  QueryChatStore,
  InMemoryAssistantSessions,
} from "../../features/query-chat/session-store.ts";
import type { MemorySpaceBackup } from "../../features/backup/index.ts";
import type { ResolvedTablePreset } from "../../features/table-presets/preset-model.ts";
import { SettingsService } from "../../features/settings/settings-service.ts";
/**
 * 记录视图冒烟测试（react-dom/server renderToString，无 jsdom——沿用 spec 测试
 * 决策）：异步加载（useEffect）在 SSR 不执行，只验证「初始态 → 加载占位」的
 * 投影契约与关键 data-action 入口存在性；完整列表/详情/表单渲染由真机验收脚本
 * （docs/playwright-st-extension/verify-record-crud.mjs）覆盖。
 */
import type { MemoryMacro, MemorySpaceId } from "../../features/memory/index.ts";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import { DEFAULT_SETTINGS } from "../../features/settings/plugin-settings.ts";
import { RecordsTab } from "./record-view.tsx";
import type { PanelRuntime } from "../shell/panel-shell.tsx";

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

function fakeRuntime(): PanelRuntime {
  return {
    sqlConsole: { execute: vi.fn(), schema: vi.fn(async () => []) },
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
    spaces: { list: vi.fn(async () => []) },
    manager: {
      getStatus: () => activeStatus(),
      onStatusChange: () => () => {},
      syncToCurrentChat: vi.fn(async () => activeStatus()),
      resolveBranch: vi.fn(async () => activeStatus()),
      importSpace: vi.fn(async () => activeStatus()),
    },
    tables: {
      list: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
    },
    fields: {
      list: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
      setDisplayStrategy: vi.fn(async () => undefined),
    },
    records: {
      list: vi.fn(async () => undefined),
      previewDisplayText: vi.fn(async () => ""),
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      delete: vi.fn(async () => false),
      find: vi.fn(async () => undefined),
      listHistory: vi.fn(async () => []),
    },
    st: {
      scrollToFloor: vi.fn(() => ({ kind: "jumped" }) as const),
      getMessageAt: vi.fn(() => undefined),
      chatMessageCount: vi.fn(() => 0),
    },
    normalizeImportedSpace: vi.fn(async (unit: MemorySpaceBackup) => unit),
    settingsService: new SettingsService({
      getChatContext: () => "test-chat",
      store: { read: () => DEFAULT_SETTINGS, write: vi.fn() },
      syncToCurrentChat: vi.fn(async () => {}),
      refreshMemoryMacros: vi.fn(async () => {}),
      validateMacros: vi.fn(async (macros: readonly MemoryMacro[]) => macros),
      getChatScopeMacros: () => [],
      refreshAgentMacros: vi.fn(async () => {}),
      refreshMirror: vi.fn(async () => {}),
      refreshVectorIndex: vi.fn(async () => {}),
      writeChatScopeMacros: vi.fn(),
    }),
    settings: {
      read: () => DEFAULT_SETTINGS,
      write: vi.fn(),
    },
    backup: {
      loadSnapshot: vi.fn(async () => ({ spaces: [] })),
      restoreSnapshot: vi.fn(async () => {}),
      restoreSpace: vi.fn(async () => {}),
      cloneSpaceFromUnit: vi.fn(async () => "new-space" as MemorySpaceId),
    },
    mirror: {
      flushRebuiltSpace: vi.fn(async () => {}),
      getStatus: () => ({ kind: "idle", lastWrittenAt: undefined, sizeBytes: undefined }),
      onStatusChange: () => () => {},
      kick: vi.fn(async () => {}),
    },
    tasks: {
      retryStates: new Map(),
      submit: vi.fn(async () => ({}) as never),
      submitInit: vi.fn(async () => ({}) as never),
      cancel: vi.fn(async () => ({}) as never),
      retry: vi.fn(async () => ({}) as never),
      activeTask: vi.fn(async () => undefined),
      pendingTasks: vi.fn(async () => []),
      recentTasks: vi.fn(async () => []),
      ledgerStatuses: vi.fn(async () => []),
      markFloorStatuses: vi.fn(async () => undefined),
    },
    spaceMaintenance: { clearRecords: vi.fn(async () => false) },
    presetUpdate: {
      preview: vi.fn(),
      apply: vi.fn(async () => ({ issues: [] })),
      retrySave: vi.fn(async () => ({ issues: [] })),
    },
    presetApply: {
      validate: vi.fn(async (preset: ResolvedTablePreset) => preset),
      assertCurrentChat: vi.fn(),
      stopSpaceWrites: vi.fn(async () => undefined),
      applyPreset: vi.fn(async () => ({ kind: "applied" as const })),
    },
    queryChat: {
      store: new QueryChatStore(new InMemoryAssistantSessions()),
      run: vi.fn(async () => undefined),
      confirm: vi.fn(async () => ({
        status: "committed" as const,
        created: 0,
        updated: 0,
        deleted: 0,
      })),
      discard: vi.fn(),
    },
    logs: {
      byKey: vi.fn(async () => []),
      recent: vi.fn(async () => []),
      clearAll: vi.fn(async () => {}),
    },
    macro: {
      subscribe: () => () => undefined,
      getRecentResults: () => [],
      skip: vi.fn(),
      testMacro: vi.fn(),
      getMigrationError: () => null,
      getMigrationConflicts: () => [],
      resolveMigrationConflict: vi.fn(),
      kick: vi.fn(async () => {}),
    },
    agentMacro: {
      kick: vi.fn(async () => {}),
    },
    cleaning: {
      readSelection: () => undefined,
      writeSelection: vi.fn(),
      readRecentMessages: () => [],
      readChatScopeMacros: () => [],
      writeChatScopeMacros: vi.fn(),
    },
    version: "0.1.0",
    presetPreview: {
      getPromptSnapshot: () => ({
        names: { user: "小明", char: "爱丽丝" },
        charCard: "",
        userCard: "",
        worldbookText: "",
        msgText: "",
      }),
      readSpaceId: () => undefined,
      readDigest: vi.fn(async () => ({ memorySpaceId: "space-1" as never, tables: [] })),
      scanWorldbook: vi.fn(async () => ({ text: "", status: "scanned" as const })),
    },
    macroOverview: () => [],
  };
}

describe("RecordsTab（记录视图投影）", () => {
  it("初始渲染：异步加载未完成 → 加载占位（SSR 不执行 useEffect）", () => {
    const html = renderToString(
      <RecordsTab
        runtime={fakeRuntime()}
        status={activeStatus()}
        settings={DEFAULT_SETTINGS}
        dataVersion={0}
      />,
    );
    expect(html).toContain("正在加载");
    expect(html).toContain('role="status"');
  });

  it("插件停用 → 停用占位优先", () => {
    const html = renderToString(
      <RecordsTab
        runtime={fakeRuntime()}
        status={activeStatus()}
        settings={{ ...DEFAULT_SETTINGS, enabled: false }}
        dataVersion={0}
      />,
    );
    expect(html).toContain("插件已停用");
  });

  it("空间未激活 → 状态占位", () => {
    const html = renderToString(
      <RecordsTab
        runtime={fakeRuntime()}
        status={{ kind: "unsaved-chat", humanMsg: "当前对话未保存，暂不支持记忆" }}
        settings={DEFAULT_SETTINGS}
        dataVersion={0}
      />,
    );
    expect(html).toContain("切换到已保存的对话后自动恢复");
  });
});
