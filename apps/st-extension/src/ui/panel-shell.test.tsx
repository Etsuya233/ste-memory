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
import { PanelModel } from "./panel-model.ts";
import { PanelShell, ToolbarButton, type PanelRuntime } from "./panel-shell.tsx";

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
    version: "0.1.0",
    ...overrides,
  };
}

function renderShell(model: PanelModel, runtime: PanelRuntime = fakeRuntime()): string {
  return renderToString(<PanelShell runtime={runtime} model={model} />);
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

describe("PanelShell（面板骨架投影）", () => {
  it("初始：收起态（aria-hidden）+ 空间名 + 四 Tab + 表格区块", () => {
    const html = renderShell(new PanelModel());
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("爱丽丝 - story");
    expect(html).toContain("云同步未配置");
    for (const label of ["表格", "记录", "任务", "设置"]) {
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

  it("设置 Tab：开关/版本/运行状态/R2 可编辑/宏占位（禁用 + 默认值）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderShell(model);
    expect(html).toContain("插件总开关");
    expect(html).toContain('data-action="toggle-plugin"');
    expect(html).toContain("v0.1.0");
    expect(html).toContain("已加载 · 空间同步正常");
    expect(html).toContain('data-stm-field="r2-account-id"');
    expect(html).toContain('data-stm-field="r2-bucket"');
    expect(html).toContain('data-stm-field="macro-name"');
    expect(html).toContain('value="{{memoryContext}}"');
    expect(html).toContain("disabled");
  });

  it("设置 Tab：R2 配置输入可编辑（ticket 08 生效，非禁用）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderShell(model);
    for (const field of [
      "r2-account-id",
      "r2-access-key-id",
      "r2-secret-access-key",
      "r2-bucket",
    ]) {
      // 每个 R2 输入都存在且不带 disabled 属性；密码框为 password 类型
      expect(html).toContain(`data-stm-field="${field}"`);
    }
    const r2Inputs = [...html.matchAll(/<input[^>]*data-stm-field="r2-[^"]+"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(r2Inputs).toHaveLength(4);
    expect(r2Inputs.every((input) => !input.includes("disabled"))).toBe(true);
    expect(html).toContain('type="password"');
    // 宏输入仍是禁用占位（ticket 15 生效）
    const macroInput = html.match(/<input[^>]*data-stm-field="macro-name"[^>]*>/)?.[0] ?? "";
    expect(macroInput).toContain("disabled");
  });

  it("设置 Tab：云同步状态组（状态/最近同步/立即同步按钮）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderShell(model);
    expect(html).toContain("同步状态");
    expect(html).toContain('data-stm-field="cloud-sync-status"');
    expect(html).toContain('data-stm-field="cloud-sync-last"');
    expect(html).toContain("尚未同步");
    expect(html).toContain('data-action="sync-now"');
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
    const html = renderShell(model, runtime);
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
    const html = renderShell(model);
    expect(html).toContain("对话文件镜像");
    expect(html).toContain('data-action="toggle-mirror"');
    expect(html).toContain('data-action="toggle-mirror-history"');
    expect(html).toContain('data-stm-field="mirror-status"');
    expect(html).toContain("已启用（尚未写回）");
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
      },
    });
    const html = renderShell(new PanelModel(), runtime);
    expect(html).toContain("已从文件镜像恢复");
  });

  it("设置 Tab：数据备份组渲染导出/导入按钮与文件输入（验收脚本契约）", () => {
    const model = new PanelModel();
    model.setTab("settings");
    const html = renderShell(model);
    expect(html).toContain("数据备份");
    expect(html).toContain('data-action="export-backup"');
    expect(html).toContain("导出备份");
    expect(html).toContain('data-action="import-backup"');
    expect(html).toContain("导入备份");
    expect(html).toContain('data-stm-field="import-backup-file"');
    expect(html).toContain('type="file"');
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

  it("记录/任务 Tab 占位文案（验收脚本契约）", () => {
    const model = new PanelModel();
    model.setTab("records");
    expect(renderShell(model)).toContain("记录视图即将开放");

    model.setTab("tasks");
    expect(renderShell(model)).toContain("任务状态即将开放");
  });
});
