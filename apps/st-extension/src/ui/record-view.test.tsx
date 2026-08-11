/**
 * 记录视图冒烟测试（react-dom/server renderToString，无 jsdom——沿用 spec 测试
 * 决策）：异步加载（useEffect）在 SSR 不执行，只验证「初始态 → 加载占位」的
 * 投影契约与关键 data-action 入口存在性；完整列表/详情/表单渲染由真机验收脚本
 * （docs/playwright-st-extension/verify-record-crud.mjs）覆盖。
 */
import type { MemorySpaceId } from "@ste-memory/core/memory";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import { DEFAULT_SETTINGS } from "../settings/plugin-settings.ts";
import { RecordsTab } from "./record-view.tsx";
import type { PanelRuntime } from "./panel-shell.tsx";

function activeStatus(): SpaceContextStatus {
  return {
    kind: "active",
    binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
    space: {
      id: "space-1" as MemorySpaceId,
      name: "爱丽丝 - story",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    created: false,
    restored: false,
  };
}

function fakeRuntime(): PanelRuntime {
  return {
    manager: {
      getStatus: () => activeStatus(),
      onStatusChange: () => () => {},
      syncToCurrentChat: vi.fn(async () => activeStatus()),
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
    settings: {
      read: () => DEFAULT_SETTINGS,
      write: vi.fn(),
    },
    backup: {
      loadSnapshot: vi.fn(async () => ({ spaces: [] })),
      restoreSnapshot: vi.fn(async () => {}),
    },
    sync: {
      getStatus: () => ({ kind: "unconfigured" }),
      onStatusChange: () => () => {},
      syncNow: vi.fn(async () => {}),
      kick: vi.fn(async () => {}),
    },
    mirror: {
      getStatus: () => ({ kind: "idle", lastWrittenAt: undefined, sizeBytes: undefined }),
      onStatusChange: () => () => {},
      kick: vi.fn(async () => {}),
    },
    tasks: {
      submit: vi.fn(async () => ({}) as never),
      cancel: vi.fn(async () => ({}) as never),
      activeTask: vi.fn(async () => undefined),
      recentTasks: vi.fn(async () => []),
      ledgerStatuses: vi.fn(async () => []),
    },
    version: "0.1.0",
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
    expect(html).toContain("记录列表准备中");
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
