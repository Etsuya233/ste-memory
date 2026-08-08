import type { MemorySpace, MemorySpaceId } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type PluginSettings } from "../settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import {
  SYNC_CONFIGURED_LABEL,
  SYNC_NOT_CONFIGURED_LABEL,
  buildSpaceInfo,
  runtimeStatusLabel,
} from "./space-info.ts";

function space(overrides: Partial<MemorySpace> = {}): MemorySpace {
  return {
    id: "space-1" as MemorySpaceId,
    name: "爱丽丝 - story",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

function status(overrides: Partial<SpaceContextStatus> = {}): SpaceContextStatus {
  return {
    kind: "active",
    binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
    space: space(),
    created: false,
    ...overrides,
  } as SpaceContextStatus;
}

function settingsWithR2(configured: boolean): PluginSettings {
  return configured
    ? {
        ...DEFAULT_SETTINGS,
        r2: { accountId: "a", accessKeyId: "b", secretAccessKey: "c", bucket: "d" },
      }
    : DEFAULT_SETTINGS;
}

describe("buildSpaceInfo（面板头部：空间名 + 同步状态占位）", () => {
  it("空间激活 + R2 未配置：名称 + 「云同步未配置」", () => {
    const info = buildSpaceInfo(status(), DEFAULT_SETTINGS);
    expect(info).toEqual({
      title: "爱丽丝 - story",
      detail: SYNC_NOT_CONFIGURED_LABEL,
      tone: "normal",
    });
  });

  it("空间激活 + R2 已配置：名称 + 「已配置（推送待开放）」", () => {
    const info = buildSpaceInfo(status(), settingsWithR2(true));
    expect(info.detail).toBe(SYNC_CONFIGURED_LABEL);
  });

  it("未保存/空间缺失/绑定无法识别：humanMsg 作标题，警示基调", () => {
    for (const kind of ["unsaved-chat", "space-missing", "binding-unrecognized"] as const) {
      const info = buildSpaceInfo(
        { kind, humanMsg: `msg-${kind}` } as SpaceContextStatus,
        DEFAULT_SETTINGS,
      );
      expect(info).toEqual({ title: `msg-${kind}`, detail: "", tone: "warning" });
    }
  });

  it("状态未就绪（首次同步前）：加载中", () => {
    expect(buildSpaceInfo(undefined, DEFAULT_SETTINGS)).toEqual({
      title: "正在加载…",
      detail: "",
      tone: "muted",
    });
  });

  it("插件停用：头部直接提示停用（优先于空间状态）", () => {
    const info = buildSpaceInfo(status(), { ...DEFAULT_SETTINGS, enabled: false });
    expect(info.title).toBe("插件已停用");
    expect(info.tone).toBe("muted");
  });
});

describe("runtimeStatusLabel（设置面板运行状态行）", () => {
  it("各状态文案齐全", () => {
    expect(runtimeStatusLabel(undefined)).toBe("启动中…");
    expect(runtimeStatusLabel(status())).toBe("已加载 · 空间同步正常");
    expect(
      runtimeStatusLabel({ kind: "unsaved-chat", humanMsg: "x" } as SpaceContextStatus),
    ).toBe("已加载 · 当前对话未保存");
    expect(
      runtimeStatusLabel({
        kind: "space-missing",
        binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
        humanMsg: "x",
      } as SpaceContextStatus),
    ).toBe("已加载 · 空间数据未就绪");
    expect(
      runtimeStatusLabel({ kind: "binding-unrecognized", humanMsg: "x" } as SpaceContextStatus),
    ).toBe("已加载 · 空间绑定无法识别");
  });
});
