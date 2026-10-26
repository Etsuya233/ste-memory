import type { MemorySpace, MemorySpaceId } from "../../features/memory/index.ts";
import type { SpaceContextStatus } from "../../features/chat-binding/chat-space-manager.ts";
import type { TablePresetSettings } from "../../features/table-presets/preset-model.ts";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TablePresetManager } from "./table-preset-manager.tsx";

const NOW = "2026-10-18T00:00:00.000Z";

function space(): MemorySpace {
  return {
    id: "space-1" as MemorySpaceId,
    name: "爱丽丝 - story",
    initializationSource: { presetId: "systemDefault", presetName: "系统默认", appliedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function activeStatus(): SpaceContextStatus {
  return {
    kind: "active",
    binding: { version: 2, spaceId: "space-1" as MemorySpaceId, chatIdentity: "char:3:story" },
    space: space(),
    created: false,
    restored: false,
  };
}

function presets(): TablePresetSettings {
  return {
    userPresets: [
      {
        id: "p1",
        name: "我的结构",
        description: "两表",
        createdAt: NOW,
        updatedAt: NOW,
        tables: [
          {
            key: "people",
            name: "人物",
            description: "",
            prompt: "",
            enabled: true,
            displayStrategy: { type: "field", fieldKey: "name" },
            fields: [
              {
                key: "name",
                name: "名称",
                type: "short_text",
                required: true,
                prompt: "",
                enabled: true,
                options: [],
                referenceTableKey: null,
                maxChars: null,
                valuePattern: null,
                valuePatternMessage: null,
              },
            ],
          },
        ],
      },
    ],
    defaultPresetId: "systemDefault",
  };
}

function render(
  overrides: {
    readonly status?: SpaceContextStatus;
    readonly pluginEnabled?: boolean;
    readonly presets?: TablePresetSettings;
  } = {},
): string {
  return renderToString(
    <TablePresetManager
      validatePreset={vi.fn(async () => {})}
      presetUpdate={{ preview: vi.fn(), apply: vi.fn(), retrySave: vi.fn() }}
      presets={overrides.presets ?? presets()}
      status={overrides.status ?? activeStatus()}
      pluginEnabled={overrides.pluginEnabled ?? true}
      onPresetsChange={() => undefined}
      readSpaceStructure={vi.fn(async () => ({ tables: [] }))}
      onPrepareApply={vi.fn(async () => undefined)}
      onApplyPreset={vi.fn(async () => ({ kind: "applied" as const }))}
      onBackupSpace={vi.fn(async () => true)}
      onDataChanged={() => undefined}
    />,
  );
}

describe("TablePresetManager（预设索引导航）", () => {
  it("索引提供预设与三个独立配置入口，正文不挂载配置表单", () => {
    const html = render();
    for (const action of [
      "open-table-preset",
      "open-default-preset",
      "open-preset-apply",
      "open-preset-capture",
    ])
      expect(html).toContain(`data-action="${action}"`);
    for (const section of ["preset-default", "preset-apply", "preset-save"])
      expect(html).not.toContain(`data-stm-section="${section}"`);
    expect(html).not.toContain('data-action="save-default-preset"');
    expect(html).not.toContain('data-action="apply-preset"');
  });
  it("预设行只展示摘要和状态，详情动作归属顶栏菜单", () => {
    const html = render();
    expect(html.match(/data-action="open-table-preset"/g)).toHaveLength(3);
    expect(html).toContain("内置");
    expect(html).not.toContain("系统自带");
    expect(html).toContain("新空间默认");
    for (const action of ["copy-preset", "rename-preset", "overwrite-preset", "delete-preset"])
      expect(html).not.toContain(`data-action="${action}"`);
  });
  it("应用入口指向当前空间，默认选择是独立入口", () => {
    const html = render();
    expect(html).toContain("爱丽丝 - story");
    expect(html).toContain("新空间默认预设");
    expect(html).toContain("应用到当前空间");
    expect(html).not.toContain("默认与当前空间");
  });
  it("无活动空间时禁用应用与保存结构；停用插件时禁用应用", () => {
    const missing: SpaceContextStatus = {
      kind: "space-missing",
      binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
      humanMsg: "空间数据未就绪",
    };
    const noSpace = render({ status: missing });
    for (const action of ["open-preset-apply", "open-preset-capture"])
      expect(noSpace.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0]).toContain(
        "disabled",
      );
    expect(noSpace).toContain("当前对话没有活动的记忆空间");
    const disabled = render({ pluginEnabled: false });
    expect(disabled.match(/<button[^>]*data-action="open-preset-apply"[^>]*>/)?.[0]).toContain(
      "disabled",
    );
    expect(disabled).toContain("插件已停用，无法应用预设");
  });
  it("旧空间没有来源信息仍可进入应用页，不在索引推断来源", () => {
    const legacy: SpaceContextStatus = {
      kind: "active",
      binding: { version: 2, spaceId: "space-1" as MemorySpaceId, chatIdentity: "char:3:story" },
      space: { ...space(), initializationSource: null },
      created: false,
      restored: false,
    };
    const html = render({ status: legacy });
    expect(html.match(/<button[^>]*data-action="open-preset-apply"[^>]*>/)?.[0]).not.toContain(
      "disabled",
    );
    expect(html).not.toContain("初始化自：系统默认");
  });
  it("索引不展示应用确认或直接清空动作", () => {
    const html = render();
    expect(html).not.toContain('data-stm-section="preset-apply-confirm"');
    expect(html).not.toContain("备份并应用");
    expect(html).not.toContain("直接清空并应用");
  });
  it("来源预设删除不会阻止进入选择页面，索引不静默执行应用", () => {
    const current = activeStatus();
    if (current.kind !== "active") throw new Error("expected active");
    const html = render({
      status: {
        ...current,
        space: {
          ...current.space,
          initializationSource: { presetId: "deleted", presetName: "已删除预设", appliedAt: NOW },
        },
      },
    });
    expect(html.match(/<button[^>]*data-action="open-preset-apply"[^>]*>/)?.[0]).not.toContain(
      "disabled",
    );
    expect(html).not.toContain('data-action="apply-preset"');
  });
});
