/**
 * 面板组件冒烟测试（react-dom/server renderToString，无 jsdom——沿用
 * spec「无组件测试基建」先例，只验证「状态 → 标记」投影的关键契约：
 * 类名 / aria 属性 / 占位文案与脚本选择器一致）。异步加载（useEffect）
 * 在 SSR 不执行，表格列表的完整渲染由真机验收脚本覆盖。
 */
import type { MemorySpaceId } from "@ste-memory/core/memory";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import { DEFAULT_SETTINGS } from "../settings/plugin-settings.ts";
import { SETTINGS_COLLAPSED_STORAGE_KEY } from "./settings-collapsed-model.ts";
import { PanelModel } from "./panel-model.ts";
import { PanelShell, MacroSettingsFields, ToolbarButton, WandEntry, type PanelRuntime } from "./panel-shell.tsx";

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

function fakeRuntime(overrides: Partial<PanelRuntime> = {}): PanelRuntime {
  return {
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
      submitInit: vi.fn(async () => ({}) as never),
      cancel: vi.fn(async () => ({}) as never),
      retry: vi.fn(async () => ({}) as never),
      activeTask: vi.fn(async () => undefined),
      recentTasks: vi.fn(async () => []),
      ledgerStatuses: vi.fn(async () => []),
      markFloorStatuses: vi.fn(async () => undefined),
    },
    spaceMaintenance: {
      clearRecords: vi.fn(async () => false),
      reset: vi.fn(async () => false),
    },
    queryChat: {
      run: vi.fn(async () => ({
        stopReason: "stop" as const,
        errorMessage: undefined,
        answer: "",
        commit: undefined,
      })),
    },
    logs: {
      byKey: vi.fn(async () => []),
      bySpace: vi.fn(async () => []),
      recent: vi.fn(async () => []),
      clearAll: vi.fn(async () => {}),
    },
    macro: {
      kick: vi.fn(async () => {}),
    },
    agentMacro: {
      kick: vi.fn(async () => {}),
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
      readDigest: vi.fn(async () => ({ memorySpaceId: "space-1" as never, tables: [] })),
      scanWorldbook: vi.fn(async () => ({ text: "", status: "scanned" as const })),
    },
    macroOverview: () => [],
    cleaning: {
      readSelection: () => undefined,
      writeSelection: vi.fn(),
      readStRegexEntries: () => [],
      readChatScopeMacros: () => [],
      writeChatScopeMacros: vi.fn(),
    },
    version: "0.1.0",
    ...overrides,
  };
}

function renderShell(model: PanelModel, runtime: PanelRuntime = fakeRuntime()): string {
  return renderToString(<PanelShell runtime={runtime} model={model} />);
}

function renderWithExpanded(
  model: PanelModel,
  keys: readonly string[],
  runtime: PanelRuntime = fakeRuntime(),
): string {
  const originalWindow = (globalThis as unknown as { window?: unknown }).window as
    { localStorage?: { getItem?: (k: string) => string | null } } | undefined;
  const prevWindow = (globalThis as unknown as Record<string, unknown>).window;
  (globalThis as unknown as Record<string, unknown>).window = {
    ...((prevWindow as object) ?? {}),
    localStorage: {
      getItem: (k: string) =>
        k === SETTINGS_COLLAPSED_STORAGE_KEY
          ? JSON.stringify(keys)
          : ((
              originalWindow as { localStorage?: { getItem: (k: string) => string | null } }
            )?.localStorage?.getItem?.(k) ?? null),
      setItem: () => {},
    },
  } as unknown;
  try {
    return renderToString(<PanelShell runtime={runtime} model={model} />);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as unknown as Record<string, unknown>).window;
    } else {
      (globalThis as unknown as Record<string, unknown>).window = prevWindow;
    }
  }
}

describe("ToolbarButton（顶部按钮投影）", () => {
  it("aria-pressed 跟随面板开关状态", () => {
    const model = new PanelModel();
    expect(renderToString(<ToolbarButton model={model} />)).toContain('aria-pressed="false"');

    model.open();
    expect(renderToString(<ToolbarButton model={model} />)).toContain('aria-pressed="true"');
  });

  it("包含图标与可访问名", () => {
    const html = renderToString(<ToolbarButton model={new PanelModel()} />);
    expect(html).toContain("fa-book-open");
    expect(html).toContain("记忆面板");
  });
});

describe("WandEntry（魔法棒入口投影）", () => {
  it("aria-pressed 跟随面板开关状态", () => {
    const model = new PanelModel();
    expect(renderToString(<WandEntry model={model} />)).toContain('aria-pressed="false"');

    model.open();
    expect(renderToString(<WandEntry model={model} />)).toContain('aria-pressed="true"');
  });

  it("结构镜像 ST 内置工具行：list-group-item + 图标 + 文本与可访问名", () => {
    const html = renderToString(<WandEntry model={new PanelModel()} />);
    expect(html).toContain("list-group-item");
    expect(html).toContain("flex-container");
    expect(html).toContain("flexGap5");
    expect(html).toContain("extensionsMenuExtensionButton");
    expect(html).toContain("fa-book-open");
    expect(html).toContain("记忆面板");
  });
});

describe("PanelShell（面板骨架投影）", () => {
  it("桌面浮动窗口：顶栏拖拽与右下角缩放手柄就位（验收脚本契约）", () => {
    const html = renderShell(new PanelModel());
    // 头部带拖拽入口；缩放是独立手柄（移动端隐藏由 CSS 控制，DOM 恒在）
    expect(html).toContain('class="stm-panel-header"');
    expect(html).toContain('data-action="drag-panel"');
    expect(html).toContain('class="stm-panel-resize"');
    expect(html).toContain('data-action="resize-panel"');
  });

  it("初始：收起态（aria-hidden）+ 空间名 + 六个 Tab + 表格区块", () => {
    const html = renderShell(new PanelModel());
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("爱丽丝 - story");
    expect(html).toContain("云同步未配置");
    for (const label of ["表格", "记录", "任务", "问答", "日志", "设置"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('data-stm-section="tables"');
    expect(html).toContain('id="stm-panel"');
  });

  it("打开：class 带 stm-panel--open、aria-hidden=false", () => {
    const model = new PanelModel();
    model.open();
    const html = renderShell(model);
    expect(html).toContain('class="stm-panel stm-panel--open"');
    expect(html).toContain('aria-hidden="false"');
  });

  it("默认表格 Tab：aria-selected 标记正确", () => {
    const model = new PanelModel();
    const html = renderShell(model);
    expect(html).toContain('data-tab="tables"');
    // 只有一个 Tab 处于选中态（表格是默认 Tab）
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('data-tab="settings"');
  });

  it("问答 Tab：模式切换/刷新入口/输入行/空状态邀请（ticket 20 验收契约）", () => {
    const model = new PanelModel();
    model.setTab("query");
    const html = renderShell(model);
    expect(html).toContain('data-tab="query"');
    expect(html).toContain("问答");
    expect(html).toContain('data-stm-section="query"');
    expect(html).toContain('data-action="query-chat-mode"');
    expect(html).toContain('data-mode="query"');
    expect(html).toContain('data-mode="fill"');
    expect(html).toContain("查询");
    expect(html).toContain("填写");
    expect(html).toContain('data-action="refresh-records"');
    expect(html).toContain('data-action="query-chat-input"');
    expect(html).toContain('data-action="query-chat-send"');
    // 空状态邀请（默认查询模式）
    expect(html).toContain("有什么想问记忆的吗？");
  });

  it("设置 Tab：开关/版本/运行状态/R2 可编辑/宏按分区（宏设置输入不常驻默认分区）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const collapsed = renderShell(model);
    // 插件总开关始终可见（不折叠）
    expect(collapsed).toContain("插件总开关");
    expect(collapsed).toContain('data-action="toggle-plugin"');
    // 其余分组默认折叠：标题与摘要可见，内部表单隐藏
    expect(collapsed).toContain('data-group="version"');
    expect(collapsed).toContain("版本与运行状态");
    expect(collapsed).toContain("v0.1.0 · 已加载");
    expect(collapsed).toContain('data-group="r2"');
    expect(collapsed).toContain("云同步（Cloudflare R2）");
    expect(collapsed).not.toContain('data-stm-field="r2-account-id"');
    expect(collapsed).toContain('data-group="macro"');
    expect(collapsed).toContain("记忆宏");
    expect(collapsed).not.toContain('data-stm-field="macro-name"');
    // 展开后 R2 表单可见；宏名/上限输入已移入「宏设置」分区，默认的全局宏分区不再渲染
    const expanded = renderWithExpanded(model, ["version", "r2", "macro"]);
    expect(expanded).toContain('data-stm-field="r2-account-id"');
    expect(expanded).toContain('data-stm-field="r2-bucket"');
    expect(expanded).not.toContain('data-stm-field="macro-name"');
    expect(expanded).not.toContain('data-stm-field="macro-limit"');
  });

  it("宏设置分区（渲染契约）：前缀/上限输入默认值 + 说明就位（宏设置 tab 内容）", () => {
    const html = renderToString(
      <MacroSettingsFields
        macroName="{{ste}}"
        macroLimit={2000}
        onNameChange={() => undefined}
        onLimitChange={() => undefined}
      />,
    );
    expect(html).toContain('data-stm-section="macro-settings"');
    expect(html).toContain('data-stm-field="macro-name"');
    expect(html).toContain('value="{{ste}}"');
    expect(html).toContain('data-stm-field="macro-limit"');
    expect(html).toContain('value="2000"');
    expect(html).toContain("超过上方字符上限从尾部截断并附「……（已截断）」标记");
  });

  it("设置 Tab：记忆宏组合并——内置/全局/对话级/宏设置分区切换就位（默认全局宏）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const expanded = renderWithExpanded(model, ["macro"]);
    // 分区切换条：四个 tab，默认选中全局宏
    expect(expanded).toContain('data-action="macro-scope"');
    expect(expanded).toContain('data-macro-scope="builtin"');
    expect(expanded).toContain('data-macro-scope="chat"');
    expect(expanded).toContain('data-macro-scope="settings"');
    expect(expanded).toContain("宏设置");
    expect(expanded).toContain('data-macro-scope="global" aria-selected="true"');
    // 默认展示全局宏内容（视图管理器）；内置/对话级/宏设置分区未渲染
    expect(expanded).toContain('data-stm-section="memory-views"');
    expect(expanded).not.toContain('data-stm-section="builtin-macros"');
    expect(expanded).not.toContain('data-stm-section="chat-scope-macros"');
    expect(expanded).not.toContain('data-stm-section="macro-settings"');
    // 折叠摘要含宏名 + 视图数 + 对话宏数
    expect(expanded).toContain("0对话宏");
  });

  it("设置 Tab：Agent 预设管理器就位（ticket 17）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const collapsed = renderShell(model);
    expect(collapsed).toContain("Agent 提示词预设");
    expect(collapsed).toContain('data-group="agent-presets"');
    expect(collapsed).toContain('aria-expanded="false"');
    // 折叠态仅标题与摘要，内部管理器隐藏
    expect(collapsed).not.toContain('data-action="select-agent-preset"');
    const expanded = renderWithExpanded(model, ["agent-presets"]);
    expect(expanded).toContain('data-stm-section="agent-presets"');
    expect(expanded).toContain('data-action="select-agent-preset"');
    expect(expanded).toContain('data-action="create-preset"');
    expect(expanded).toContain('data-action="copy-builtin-preset"');
  });

  it("任务 Tab：Agent 预设快捷切换下拉就位（ticket 17）", () => {
    const model = new PanelModel();
    model.setTab("tasks");
    const html = renderShell(model);
    expect(html).toContain('data-stm-section="preset"');
    expect(html).toContain('data-action="select-agent-preset"');
    expect(html).toContain("系统默认");
  });

  it("设置 Tab：R2 配置输入可编辑（ticket 08 生效，非禁用）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderWithExpanded(model, ["r2", "macro"]);
    for (const field of [
      "r2-account-id",
      "r2-access-key-id",
      "r2-secret-access-key",
      "r2-bucket",
    ]) {
      expect(html).toContain(`data-stm-field="${field}"`);
    }
    const r2Inputs = [...html.matchAll(/<input[^>]*data-stm-field="r2-[^"]+"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(r2Inputs).toHaveLength(4);
    expect(r2Inputs.every((input) => !input.includes("disabled"))).toBe(true);
    expect(html).toContain('type="password"');
    // 宏名/上限输入已移入「宏设置」分区（非默认分区，不随展开了全局宏分区出现）
    expect(html).not.toContain('data-stm-field="macro-name"');
  });

  it("设置 Tab：云同步状态组（状态/最近同步/立即同步按钮）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const collapsed = renderShell(model);
    expect(collapsed).toContain("云同步（Cloudflare R2）");
    expect(collapsed).toContain('data-group="r2"');
    expect(collapsed).not.toContain('data-stm-field="cloud-sync-status"');
    const html = renderWithExpanded(model, ["r2"]);
    expect(html).toContain('data-stm-field="cloud-sync-status"');
    expect(html).toContain('data-stm-field="cloud-sync-last"');
    expect(html).toContain("尚未同步");
    expect(html).toContain('data-action="sync-now"');
  });

  it("设置 Tab：危险操作区两个按钮就位（spec reset-space，active 状态可用）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const collapsed = renderShell(model);
    expect(collapsed).toContain("危险操作");
    expect(collapsed).toContain('data-group="danger"');
    expect(collapsed).not.toContain("清除空间记录");
    const html = renderWithExpanded(model, ["danger"]);
    expect(html).toContain("清除空间记录");
    expect(html).toContain("重置空间");
    const clearButton =
      html.match(/<button[^>]*data-action="clear-space-records"[^>]*>/)?.[0] ?? "";
    const resetButton = html.match(/<button[^>]*data-action="reset-space"[^>]*>/)?.[0] ?? "";
    expect(clearButton).not.toContain("disabled");
    expect(resetButton).not.toContain("disabled");
  });

  it("设置 Tab：无有效空间时危险操作按钮置灰（spec reset-space）", () => {
    const missing: SpaceContextStatus = {
      kind: "space-missing",
      binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
      humanMsg: "空间数据未就绪",
    };
    const runtime = fakeRuntime({
      manager: {
        getStatus: () => missing,
        onStatusChange: () => () => {},
        syncToCurrentChat: vi.fn(async () => missing),
        resolveBranch: vi.fn(async () => missing),
        importSpace: vi.fn(async () => missing),
      },
    });
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderWithExpanded(model, ["danger"], runtime);
    const clearButton =
      html.match(/<button[^>]*data-action="clear-space-records"[^>]*>/)?.[0] ?? "";
    const resetButton = html.match(/<button[^>]*data-action="reset-space"[^>]*>/)?.[0] ?? "";
    expect(clearButton).toContain("disabled");
    expect(resetButton).toContain("disabled");
  });

  it("设置 Tab：插件停用时危险操作按钮置灰（spec reset-space）", () => {
    const runtime = fakeRuntime({
      settings: {
        read: () => ({ ...DEFAULT_SETTINGS, enabled: false }),
        write: vi.fn(),
      },
    });
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderWithExpanded(model, ["danger"], runtime);
    const clearButton =
      html.match(/<button[^>]*data-action="clear-space-records"[^>]*>/)?.[0] ?? "";
    const resetButton = html.match(/<button[^>]*data-action="reset-space"[^>]*>/)?.[0] ?? "";
    expect(clearButton).toContain("disabled");
    expect(resetButton).toContain("disabled");
  });

  it("设置 Tab：同步失败时失败提示可见（含消息文本）", () => {
    const runtime = fakeRuntime({
      sync: {
        getStatus: () => ({
          kind: "error",
          message: "R2 访问被拒绝（HTTP 403）",
          lastSyncAt: undefined,
        }),
        onStatusChange: () => () => {},
        syncNow: vi.fn(async () => {}),
        kick: vi.fn(async () => {}),
      },
    });
    const model = new PanelModel();
    model.setTab("settings");
    const collapsed = renderShell(model, runtime);
    // 折叠态摘要应包含失败信息
    expect(collapsed).toContain("失败");
    expect(collapsed).toContain("R2 访问被拒绝");
    const html = renderWithExpanded(model, ["r2"], runtime);
    expect(html).toContain("失败提示");
    expect(html).toContain('data-stm-field="cloud-sync-error"');
    expect(html).toContain("R2 访问被拒绝（HTTP 403）");
    expect(html).toContain("云同步失败");
  });

  it("面板头部：同步失败时显示失败提示（ticket 08 替换占位文案）", () => {
    const runtime = fakeRuntime({
      sync: {
        getStatus: () => ({
          kind: "error",
          message: "无法连接 R2",
          lastSyncAt: "2026-08-09T00:00:00.000Z",
        }),
        onStatusChange: () => () => {},
        syncNow: vi.fn(async () => {}),
        kick: vi.fn(async () => {}),
      },
    });
    const html = renderShell(new PanelModel(), runtime);
    expect(html).toContain("云同步失败：无法连接 R2");
  });

  it("设置 Tab：对话文件镜像组（开关 + 包含修订历史 + 状态展示）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const collapsed = renderShell(model);
    expect(collapsed).toContain("对话文件镜像");
    expect(collapsed).toContain('data-group="mirror"');
    expect(collapsed).toContain("已启用（尚未写回）");
    expect(collapsed).not.toContain('data-action="toggle-mirror"');
    const html = renderWithExpanded(model, ["mirror"]);
    expect(html).toContain('data-action="toggle-mirror"');
    expect(html).toContain('data-action="toggle-mirror-history"');
    expect(html).toContain('data-stm-field="mirror-status"');
  });

  it("设置 Tab：镜像已写回时状态行展示时间与体积", () => {
    const runtime = fakeRuntime({
      mirror: {
        getStatus: () => ({
          kind: "idle",
          lastWrittenAt: "2026-08-10T01:02:03.000Z",
          sizeBytes: 15360,
        }),
        onStatusChange: () => () => {},
        kick: vi.fn(async () => {}),
      },
    });
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderShell(model, runtime);
    expect(html).toContain("上次写回 2026-08-10 01:02");
    expect(html).toContain("15.0 KB");
  });

  it("面板头部：从文件镜像恢复时展示恢复标记", () => {
    const status: SpaceContextStatus = {
      kind: "active",
      binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
      space: {
        id: "space-1" as MemorySpaceId,
        name: "爱丽丝 - story",
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
      created: false,
      restored: true,
    };
    const runtime = fakeRuntime({
      manager: {
        getStatus: () => status,
        onStatusChange: () => () => {},
        syncToCurrentChat: vi.fn(async () => status),
        resolveBranch: vi.fn(async () => status),
        importSpace: vi.fn(async () => status),
      },
    });
    const html = renderShell(new PanelModel(), runtime);
    expect(html).toContain("已从文件镜像恢复");
  });

  it("设置 Tab：数据备份组渲染导出/导入按钮与文件输入（验收脚本契约）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const collapsed = renderShell(model);
    expect(collapsed).toContain("数据备份");
    expect(collapsed).toContain('data-group="backup"');
    expect(collapsed).not.toContain('data-action="export-backup"');
    const html = renderWithExpanded(model, ["backup"]);
    expect(html).toContain('data-action="export-backup"');
    expect(html).toContain("导出备份");
    expect(html).toContain('data-action="import-backup"');
    expect(html).toContain("导入备份");
    expect(html).toContain('data-stm-field="import-backup-file"');
    expect(html).toContain('type="file"');
  });

  it("设置 Tab：数据备份组渲染单空间导出/导入入口（issue 26 验收契约）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderWithExpanded(model, ["backup"]);
    expect(html).toContain('data-action="export-space-backup"');
    expect(html).toContain("导出当前空间");
    expect(html).toContain('data-action="import-space-backup"');
    expect(html).toContain("导入到当前空间");
    expect(html).toContain('data-stm-field="import-space-backup-file"');
  });

  it("导出当前空间按钮：绑定空间时可用，无绑定（space-missing）时置灰并提示", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderWithExpanded(model, ["backup"]);
    const button = html.match(/<button[^>]*data-action="export-space-backup"[^>]*>/)?.[0] ?? "";
    expect(button).not.toContain("disabled");

    const missing: SpaceContextStatus = {
      kind: "space-missing",
      binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
      humanMsg: "空间数据未就绪",
    };
    const runtime = fakeRuntime({
      manager: {
        getStatus: () => missing,
        onStatusChange: () => () => {},
        syncToCurrentChat: vi.fn(async () => missing),
        resolveBranch: vi.fn(async () => missing),
        importSpace: vi.fn(async () => missing),
      },
    });
    const html2 = renderWithExpanded(model, ["backup"], runtime);
    const disabledButton =
      html2.match(/<button[^>]*data-action="export-space-backup"[^>]*>/)?.[0] ?? "";
    expect(disabledButton).toContain("disabled");
    expect(disabledButton).toContain("当前对话未绑定记忆空间");
  });

  it("导入到当前空间按钮：始终可用（无论是否绑定，issue 26 用户 story 21）", () => {
    const missing: SpaceContextStatus = {
      kind: "space-missing",
      binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
      humanMsg: "空间数据未就绪",
    };
    const runtime = fakeRuntime({
      manager: {
        getStatus: () => missing,
        onStatusChange: () => () => {},
        syncToCurrentChat: vi.fn(async () => missing),
        resolveBranch: vi.fn(async () => missing),
        importSpace: vi.fn(async () => missing),
      },
    });
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderWithExpanded(model, ["backup"], runtime);
    const button = html.match(/<button[^>]*data-action="import-space-backup"[^>]*>/)?.[0] ?? "";
    expect(button).not.toContain("disabled");
  });

  it("插件停用：头部提示 + 表格区块占位（设置优先于空间状态）", () => {
    const runtime = fakeRuntime({
      settings: {
        read: () => ({ ...DEFAULT_SETTINGS, enabled: false }),
        write: vi.fn(),
      },
    });
    const html = renderShell(new PanelModel(), runtime);
    expect(html).toContain("插件已停用");
    expect(html).not.toContain("爱丽丝 - story");
  });

  it("设置 Tab：折叠与重排序（spec 移动端优化）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderShell(model);
    // 插件总开关不折叠，无 aria-expanded
    expect(html).toContain('data-group="plugin-toggle"');
    // 其余分组默认折叠：aria-expanded=false + chevron-down
    for (const group of [
      "macro",
      "agent-connections",
      "agent-presets",
      "cleaning",
      "backup",
      "mirror",
      "r2",
      "version",
      "safe-area",
      "danger",
    ]) {
      expect(html).toContain(`data-group="${group}"`);
      expect(html).toContain(`data-action="toggle-settings-group"`);
    }
    expect(html.match(/aria-expanded="false"/g)?.length).toBeGreaterThanOrEqual(10);
    expect(html).toContain("fa-chevron-down");
    // 摘要在折叠态可见
    expect(html).toContain("{{ste}}");
    expect(html).toContain("未配置");
    // 顺序：插件总开关 < 记忆宏 < Agent 连接 < Agent 预设 < 清洗规则 < 数据备份 < 对话文件镜像 < 云同步 < 版本 < 面板安全区 < 危险操作
    const order = [
      "插件总开关",
      "记忆宏",
      "Agent 连接",
      "Agent 提示词预设",
      "清洗规则",
      "数据备份",
      "对话文件镜像",
      "云同步（Cloudflare R2）",
      "版本与运行状态",
      "面板入口",
      "面板安全区",
      "危险操作",
    ];
    let lastIdx = -1;
    for (const title of order) {
      const idx = html.indexOf(title);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("设置 Tab：面板安全区组（四边输入 + 预设 + 折叠摘要）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    // 折叠态：分组存在 + 摘要显示“未调整”（默认全 0）
    const collapsed = renderShell(model);
    expect(collapsed).toContain('data-group="safe-area"');
    expect(collapsed).toContain("未调整");
    // 展开态：四边数字输入（默认 0，带中文标签）+ 两个预设按钮 + 清空按钮
    const expanded = renderWithExpanded(model, ["safe-area"]);
    for (const edge of ["top", "bottom", "left", "right"]) {
      expect(expanded).toContain(`data-stm-field="safe-area-${edge}"`);
    }
    expect(expanded.match(/value="0"/g)?.length).toBeGreaterThanOrEqual(4);
    // 无障碍：每个输入被中文边名 label 包裹
    for (const label of ["上", "下", "左", "右"]) {
      expect(expanded).toContain(`<span class="stm-setting-name">${label}</span>`);
    }
    expect(expanded).toContain('data-action="apply-safe-area-preset"');
    expect(expanded).toContain('data-preset="iphone-dynamic-island"');
    expect(expanded).toContain('data-preset="iphone-notch"');
    expect(expanded).toContain('data-action="clear-safe-area"');
  });

  it("设置 Tab：面板入口组（三选项 + 折叠摘要显示当前选择）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    // 折叠态：分组存在 + 摘要显示默认选择“顶部导航栏”，选项控件不渲染
    const collapsed = renderShell(model);
    expect(collapsed).toContain('data-group="entry"');
    expect(collapsed).toContain("面板入口");
    expect(collapsed).toContain("顶部导航栏");
    expect(collapsed).not.toContain('data-action="set-entry-placement"');
    // 展开态：三个选项按钮（顶部导航栏 / 底部魔法棒 / 两者都显示）
    const expanded = renderWithExpanded(model, ["entry"]);
    expect(expanded).toContain('data-action="set-entry-placement"');
    for (const placement of ["top", "wand", "both"]) {
      expect(expanded).toContain(`data-placement="${placement}"`);
    }
    for (const label of ["顶部导航栏", "底部魔法棒", "两者都显示"]) {
      expect(expanded).toContain(label);
    }
    // 未回退：不出现“魔法棒不可用”提示
    expect(expanded).not.toContain("魔法棒不可用");
  });

  it("设置 Tab：入口回退时摘要附加标记、组内提示实际位置", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const runtime = fakeRuntime({
      settings: {
        read: () => ({ ...DEFAULT_SETTINGS, entryPlacement: "wand" }),
        write: vi.fn(),
      },
      entryMount: {
        getPlan: () => ({ top: true, wand: false, fallback: true }),
        onPlanChange: () => () => {},
        replan: vi.fn(),
      },
    });
    // 折叠态摘要：选择 + 回退标记
    const collapsedModel = new PanelModel();
    collapsedModel.setTab("settings");
    const collapsed = renderShell(collapsedModel, runtime);
    expect(collapsed).toContain("底部魔法棒（已回退顶部）");
    // 展开态：实际位置提示可见
    const expandedModel = new PanelModel();
    expandedModel.setTab("settings");
    const expanded = renderWithExpanded(expandedModel, ["entry"], runtime);
    expect(expanded).toContain("实际位置：顶部导航栏（魔法棒不可用）");
  });

  it("设置 Tab：展开后云同步合并组包含配置与状态", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderWithExpanded(model, ["r2"]);
    // 合并后同一展开体内包含 4 输入 + 状态 + 立即同步
    expect(html).toContain('data-stm-field="r2-account-id"');
    expect(html).toContain('data-stm-field="cloud-sync-status"');
    expect(html).toContain('data-stm-field="cloud-sync-last"');
    expect(html).toContain('data-action="sync-now"');
    // 旧独立“同步状态”标题不再存在，统一为云同步标题
    expect(html).not.toContain(">同步状态<");
  });

  it("记录/任务 Tab：记录视图加载态 + 任务触发区（ticket 13 替换占位，验收脚本契约）", () => {
    const model = new PanelModel();
    model.setTab("records");
    const recordsHtml = renderShell(model);
    expect(recordsHtml).toContain('data-stm-section="records"');
    // SSR 不执行异步加载：记录视图呈现加载态（ticket 11 替换占位）
    expect(recordsHtml).toContain("正在加载");
    expect(recordsHtml).not.toContain("记录视图即将开放");

    model.setTab("tasks");
    const tasksHtml = renderShell(model);
    expect(tasksHtml).toContain('data-stm-section="tasks"');
    // SSR 不执行异步加载（TasksTab 视图未就绪渲染空）；占位文案已移除
    expect(tasksHtml).not.toContain("任务状态即将开放");
    expect(tasksHtml).not.toContain("手动指定楼层范围触发填表任务");
  });
});
