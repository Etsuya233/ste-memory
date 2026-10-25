import { DEFAULT_AUTO_FILL_SETTINGS } from "../../features/fill-tasks/auto-fill-settings.ts";
/**
 * Agent 预设管理器冒烟测试（react-dom/server renderToString，无 jsdom）：
 * 验证渲染契约（data-action / data-stm-field）与关键态（系统默认只读视图、
 * 自定义预设消息卡片、角色标签、digest 缺失警告）。交互逻辑在 preset-model 测试覆盖。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PluginSettings } from "../../features/settings/plugin-settings.ts";
import {
  BUILTIN_AGENT_PRESET_ID,
  type AgentPresetSettings,
} from "../../features/agent-presets/preset-model.ts";
import type { AgentPresetPreviewPorts } from "../../features/agent-presets/preset-preview-model.ts";
import {
  AgentPresetManager,
  AgentPresetPreviewDialog,
  AgentPresetPreviewPanel,
} from "./agent-preset-manager.tsx";
import type { AgentPresetPreviewItem } from "../../features/agent-presets/preset-preview-model.ts";

function presetSettings(overrides: Partial<AgentPresetSettings> = {}): AgentPresetSettings {
  return {
    presets: [
      {
        id: "p1",
        name: "破限",
        messages: [
          {
            id: "f1",
            name: "规则A",
            role: "system",
            content: "你是{{char}}的破限填写员",
            enabled: true,
          },
          { id: "f2", name: "", role: "user", content: "{{tablesDigest}}", enabled: true },
        ],
      },
      {
        id: "p2",
        name: "无摘要",
        messages: [{ id: "f3", name: "", role: "system", content: "只管填", enabled: true }],
      },
    ],
    activePresetId: "p1",
    ...overrides,
  };
}

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    fillAgentTimeoutSeconds: 300,
    autoFill: DEFAULT_AUTO_FILL_SETTINGS,
    enabled: true,
    macroName: "{{memoryContext}}",
    macroLimit: 2000,
    mirror: { enabled: true, includeHistory: true },
    agentPresets: presetSettings(),
    agentConnections: [],
    fillTaskConnectionId: undefined,
    queryChatConnectionId: undefined,
    cleaningSchemaVersion: 2,
    cleaningRuleLists: [],
    memoryViews: [],
    tablePresets: { userPresets: [], defaultPresetId: "systemDefault" },
    entryPlacement: "top",
    ...overrides,
  };
}

function fakePreviewPorts(): AgentPresetPreviewPorts {
  return {
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
  };
}

function render(settingsValue: PluginSettings): string {
  return renderToString(
    <AgentPresetManager
      settings={settingsValue}
      presetPreview={fakePreviewPorts()}
      onChange={() => undefined}
    />,
  );
}

describe("AgentPresetManager（列表导航首屏）", () => {
  it("列出内置与用户预设，当前使用状态独立于详情浏览", () => {
    const html = render(settings());
    expect(html).toContain('data-stm-section="agent-presets"');
    expect(html).toContain('data-preset-id="systemDefault"');
    expect(html).toContain('data-preset-id="p1"');
    expect(html).toContain("破限");
    expect(html).toContain("无摘要");
    expect(html).toContain("当前使用");
    expect(html).toContain('data-action="drag-preset"');
  });
  it("首屏只提供创建导入，编辑导出删除与消息操作属于详情", () => {
    const html = render(settings());
    expect(html).toContain('data-action="create-preset"');
    expect(html).toContain('data-action="import-preset"');
    for (const action of [
      "duplicate-preset",
      "delete-preset",
      "export-preset",
      "toggle-message",
      "remove-message",
    ])
      expect(html).not.toContain(`data-action="${action}"`);
  });
  it("当前使用内置预设时仍先展示列表，不自动进入只读详情", () => {
    const html = render(
      settings({ agentPresets: presetSettings({ activePresetId: BUILTIN_AGENT_PRESET_ID }) }),
    );
    expect(html).toContain("系统默认");
    expect(html).not.toContain('data-stm-section="builtin-preset"');
    expect(html).not.toContain('data-action="copy-builtin-preset"');
  });
  it("列表不提前展开消息正文与详情警告", () => {
    const html = render(settings({ agentPresets: presetSettings({ activePresetId: "p2" }) }));
    expect(html).not.toContain('data-stm-field="digest-warning"');
    expect(html).not.toContain("你是{{char}}的破限填写员");
    expect(html).toContain('data-action="select-agent-preset"');
  });
});

describe("AgentPresetManager（预设预览 · issue 01）", () => {
  it("列表首屏不展开预览，预览在对象详情中触发", () => {
    const html = render(settings());
    expect(html).not.toContain('data-action="preview-preset"');
    expect(html).not.toContain('data-stm-section="preset-preview"');
  });

  it("选中系统默认预设：不出现预览按钮（展开内容即 {{systemDefaultPrompt}} 宏）", () => {
    const html = render(
      settings({ agentPresets: presetSettings({ activePresetId: BUILTIN_AGENT_PRESET_ID }) }),
    );
    expect(html).not.toContain('data-action="preview-preset"');
  });

  it("预览面板：差异提示行 + 输入框 + 「重新展开」 + 条目卡片（角色/来源/展开文本/复制）", () => {
    const items: readonly AgentPresetPreviewItem[] = [
      {
        id: "f1",
        role: "system",
        sourceName: "规则A",
        text: "你是爱丽丝的破限填写员",
        note: undefined,
      },
      {
        id: "f2",
        role: "user",
        sourceName: "表格摘要",
        text: "",
        note: "{{msg}} 依赖任务块消息，预览中无输入 → 展开为空串",
      },
    ];
    const html = renderToString(
      <AgentPresetPreviewPanel
        items={items}
        loading={false}
        error={undefined}
        previewText=""
        onPreviewTextChange={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    // 差异提示一行可见
    expect(html).toContain('data-stm-field="preset-preview-hint"');
    expect(html).toContain("预览为当前时刻内容，任务提交时以最新数据重新展开");
    // 输入框 + 重新展开按钮
    expect(html).toContain('data-stm-field="preset-preview-text"');
    expect(html).toContain('data-action="refresh-preset-preview"');
    // 按编排形态分组：系统提示词 / 对话前缀
    expect(html).toContain("系统提示词（合并进系统提示词，按预设顺序）");
    expect(html).toContain("对话前缀（User / Assistant 按预设顺序进入对话）");
    // 卡片：角色标签 + 来源名 + 展开文本 + 复制按钮
    expect(html).toContain('data-stm-field="preview-message-f1"');
    expect(html).toContain('data-stm-field="preview-message-role"');
    expect(html).toContain(">System</span>");
    expect(html).toContain("规则A");
    expect(html).toContain("你是爱丽丝的破限填写员");
    expect(html).toContain('data-action="copy-preset-preview-message"');
    // 标注可见
    expect(html).toContain('data-stm-field="preset-preview-note"');
    expect(html).toContain("依赖任务块消息");
  });

  it("预览弹窗（UI 改版）：标题 + 面板内容 + 底部右侧 复制全部/关闭", () => {
    const items: readonly AgentPresetPreviewItem[] = [
      {
        id: "f1",
        role: "system",
        sourceName: "规则A",
        text: "你是爱丽丝的破限填写员",
        note: undefined,
      },
    ];
    const html = renderToString(
      <AgentPresetPreviewDialog
        presetName="破限"
        items={items}
        loading={false}
        error={undefined}
        previewText=""
        onPreviewTextChange={() => undefined}
        onRefresh={() => undefined}
        onClose={() => undefined}
      />,
    );
    // 弹窗标题 = 预设名；内容区 = 原面板（差异提示 + 输入框 + 卡片）
    expect(html).toContain("预览「破限」");
    expect(html).toContain('data-stm-section="preview-modal"');
    expect(html).toContain('data-stm-field="preset-preview-hint"');
    expect(html).toContain('data-stm-field="preset-preview-text"');
    expect(html).toContain('data-stm-field="preview-message-f1"');
    // 底部右侧：复制（全部展开消息）+ 关闭
    expect(html).toContain('data-action="copy-preview"');
    expect(html).toContain('data-action="close-preview-modal"');
  });

  it("预览面板：构建失败时显示错误、不渲染条目", () => {
    const html = renderToString(
      <AgentPresetPreviewPanel
        items={[]}
        loading={false}
        error="读取 ST 上下文失败"
        previewText=""
        onPreviewTextChange={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain('data-stm-field="preset-preview-error"');
    expect(html).toContain("读取 ST 上下文失败");
    expect(html).not.toContain('data-stm-field="preview-message-f1"');
  });

  it("预览面板：加载中显示占位提示", () => {
    const html = renderToString(
      <AgentPresetPreviewPanel
        items={[]}
        loading
        error={undefined}
        previewText=""
        onPreviewTextChange={() => undefined}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain('data-stm-field="preset-preview-loading"');
    expect(html).toContain("正在构建展开数据");
  });
});
