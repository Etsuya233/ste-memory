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

describe("TablePresetManager（设置 Tab 表格预设分组冒烟）", () => {
  it("三个分区就位：新空间默认 / 当前空间应用 / 预设管理", () => {
    const html = render();
    expect(html).toContain('data-stm-section="preset-default"');
    expect(html).toContain('data-stm-section="preset-apply"');
    expect(html).toContain('data-stm-section="preset-library"');
    expect(html).toContain('data-action="save-default-preset"');
    expect(html).toContain('data-action="apply-preset"');
    expect(html).toContain('data-action="save-space-as-preset"');
    // 默认选择与当前空间无关：仅影响之后创建的全新空间
    expect(html).toContain("仅影响之后创建的全新记忆空间");
  });

  it("预设库：系统自带预设只读（复制可用），用户预设可重命名/覆盖/删除", () => {
    const html = render();
    const systemCopy = html.match(/<button[^>]*data-action="copy-preset"[^>]*>/)?.[0] ?? "";
    expect(systemCopy).not.toContain("disabled");
    const renameButtons = html.match(/<button[^>]*data-action="rename-preset"[^>]*>/g) ?? [];
    expect(renameButtons).toHaveLength(2);
    expect(renameButtons[0]).toContain("disabled"); // 系统自带
    expect(renameButtons[1]).not.toContain("disabled");
    const deleteButtons = html.match(/<button[^>]*data-action="delete-preset"[^>]*>/g) ?? [];
    expect(deleteButtons[0]).toContain("disabled");
    expect(deleteButtons[1]).not.toContain("disabled");
    expect(html).toContain("系统自带");
    expect(html).toContain("新空间默认");
    expect(html).toContain("另存为预设");
  });

  it("应用区：显示空间名与初始化来源；来源 ID 与默认目标相同时用重新初始化文案", () => {
    const html = render();
    expect(html).toContain('data-stm-field="preset-space-name"');
    expect(html).toContain("爱丽丝 - story");
    expect(html).toContain("初始化自：系统默认");
    expect(html).toContain("按此预设重新初始化");
    expect(html).toContain("结构预览");
    // 预览默认收起（选择只改草稿，不写空间）
    expect(html).not.toContain('data-stm-field="preset-apply-preview"');
  });

  it("无活动空间 / 插件停用：应用与另存不可用并给出原因", () => {
    const missing: SpaceContextStatus = {
      kind: "space-missing",
      binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
      humanMsg: "空间数据未就绪",
    };
    const noSpace = render({ status: missing });
    const applyButton = noSpace.match(/<button[^>]*data-action="apply-preset"[^>]*>/)?.[0] ?? "";
    expect(applyButton).toContain("disabled");
    const saveButton =
      noSpace.match(/<button[^>]*data-action="save-space-as-preset"[^>]*>/)?.[0] ?? "";
    expect(saveButton).toContain("disabled");
    expect(noSpace).toContain("当前对话没有活动的记忆空间");

    const disabled = render({ pluginEnabled: false });
    expect(disabled).toContain("插件已停用，无法应用预设");
  });

  it("有空间但无来源信息：显示「初始化来源未记录」，不推断来自当前默认预设（spec 6.2）", () => {
    const legacy: SpaceContextStatus = {
      kind: "active",
      binding: { version: 2, spaceId: "space-1" as MemorySpaceId, chatIdentity: "char:3:story" },
      space: { ...space(), initializationSource: null },
      created: false,
      restored: false,
    };
    const html = render({ status: legacy });
    expect(html).toContain("初始化来源未记录");
    expect(html).toContain('data-action="apply-preset"');
    const applyButton = html.match(/<button[^>]*data-action="apply-preset"[^>]*>/)?.[0] ?? "";
    expect(applyButton).not.toContain("disabled");
    expect(html).toContain("应用到当前空间");
  });

  it("确认框初始不渲染：应用需先点击（一次确认流程）", () => {
    const html = render();
    expect(html).not.toContain('data-stm-section="preset-apply-confirm"');
    expect(html).not.toContain("备份并应用");
    expect(html).not.toContain("直接清空并应用");
  });

  it("来源预设已删除：明确要求重新选择，不能静默应用系统默认", () => {
    const status = activeStatus();
    if (status.kind !== "active") throw new Error("expected active");
    const html = render({
      status: {
        ...status,
        space: {
          ...status.space,
          initializationSource: { presetId: "deleted", presetName: "已删除预设", appliedAt: NOW },
        },
      },
    });
    expect(html).toContain("请选择有效的表格预设");
    expect(html.match(/<button[^>]*data-action="apply-preset"[^>]*>/)?.[0]).toContain("disabled");
    expect(html).toContain("初始化自：已删除预设");
  });
});
