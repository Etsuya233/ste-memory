/**
 * Agent 预设管理器冒烟测试（react-dom/server renderToString，无 jsdom）：
 * 验证渲染契约（data-action / data-stm-field）与关键态（系统默认只读视图、
 * 自定义预设片段卡片、digest 缺失警告）。交互逻辑在 preset-model 测试覆盖。
 */
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import {
  BUILTIN_AGENT_PRESET_ID,
  type AgentPresetSettings,
} from "../agent-presets/preset-model.ts";
import { AgentPresetManager } from "./agent-preset-manager.tsx";

function presetSettings(overrides: Partial<AgentPresetSettings> = {}): AgentPresetSettings {
  return {
    presets: [
      {
        id: "p1",
        name: "破限",
        fragments: [
          { id: "f1", name: "规则A", content: "你是{{char}}的破限填写员", enabled: true },
          { id: "f2", name: "", content: "{{tablesDigest}}", enabled: true },
        ],
      },
      {
        id: "p2",
        name: "无摘要",
        fragments: [{ id: "f3", name: "", content: "只管填", enabled: true }],
      },
    ],
    activePresetId: "p1",
    ...overrides,
  };
}

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    enabled: true,
    r2: { accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "" },
    macroName: "{{memoryContext}}",
    macroLimit: 2000,
    mirror: { enabled: true, includeHistory: true },
    agentPresets: presetSettings(),
    ...overrides,
  };
}

function render(settingsValue: PluginSettings): string {
  return renderToString(
    <AgentPresetManager settings={settingsValue} onChange={() => undefined} />,
  );
}

describe("AgentPresetManager（预设管理区块冒烟）", () => {
  it("标题 + 预设列表（系统默认 + 用户预设）就位，活动行标记 + 拖拽手柄", () => {
    const html = render(settings());
    expect(html).toContain("Agent 提示词预设");
    expect(html).toContain('data-stm-field="preset-list"');
    expect(html).toContain('data-action="select-agent-preset"');
    expect(html).toContain("系统默认");
    expect(html).toContain("内置");
    expect(html).toContain("破限");
    expect(html).toContain("无摘要");
    expect(html).toContain('data-action="drag-preset"');
    // 活动预设行（p1）带 active 类
    expect(html).toContain('class="stm-preset-row stm-preset-row--active"');
  });

  it("操作按钮契约：新建/复制/删除/导出/导入", () => {
    const html = render(settings());
    for (const action of [
      "create-preset",
      "duplicate-preset",
      "delete-preset",
      "export-preset",
      "import-preset",
    ]) {
      expect(html).toContain(`data-action="${action}"`);
    }
  });

  it("系统默认（活动 = systemDefault）：只读说明 + 复制为自定义；编辑按钮禁用", () => {
    const html = render(settings({ agentPresets: presetSettings({ activePresetId: BUILTIN_AGENT_PRESET_ID }) }));
    expect(html).toContain('data-stm-section="builtin-preset"');
    expect(html).toContain("系统默认预设");
    expect(html).toContain('data-action="copy-builtin-preset"');
    expect(html).not.toContain('data-stm-section="preset-editor"');
    expect(html).toContain('data-action="duplicate-preset" disabled');
  });

  it("自定义预设：片段卡片（拖拽手柄/开关/标题/删除）就位，卡片编号显示", () => {
    const html = render(settings());
    expect(html).toContain('data-stm-section="preset-editor"');
    expect(html).toContain('data-stm-field="preset-name"');
    expect(html).toContain('data-action="drag-fragment"');
    expect(html).toContain('data-stm-field="fragment-enabled-f1"');
    expect(html).toContain('data-action="toggle-fragment"');
    expect(html).toContain('data-action="remove-fragment"');
    expect(html).toContain('data-action="add-fragment"');
    // 名称回退首行：f2 无名 → 预览 = 内容首行
    expect(html).toContain("{{tablesDigest}}");
  });

  it("活动预设未引用 digest：常驻警告就位", () => {
    const html = render(settings({ agentPresets: presetSettings({ activePresetId: "p2" }) }));
    expect(html).toContain('data-stm-field="digest-warning"');
    expect(html).toContain("工具可用性下降");
  });

  it("活动预设引用 digest：无警告", () => {
    const html = render(settings());
    expect(html).not.toContain('data-stm-field="digest-warning"');
  });
});
