import type { MemorySpace, MemorySpaceId } from "@ste-memory/core/memory";
import { describe, expect, it } from "vitest";
import type { CloudSyncStatus } from "../cloud/sync-coordinator.ts";
import { DEFAULT_SETTINGS, type PluginSettings } from "../settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import {
  SYNC_NOT_CONFIGURED_LABEL,
  SYNC_PENDING_LABEL,
  SYNC_SYNCING_LABEL,
  buildSpaceInfo,
  formatSyncTime,
  mirrorStatusSummary,
  runtimeStatusLabel,
  syncStatusDetail,
  syncStatusSummary,
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
    restored: false,
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

describe("buildSpaceInfo（面板头部：空间名 + 真实同步状态，ticket 08）", () => {
  it("空间激活 + 未配置：名称 + 「云同步未配置」", () => {
    const info = buildSpaceInfo(status(), DEFAULT_SETTINGS, { kind: "unconfigured" });
    expect(info).toEqual({
      title: "爱丽丝 - story",
      detail: SYNC_NOT_CONFIGURED_LABEL,
      tone: "normal",
    });
  });

  it("空间激活 + 同步中/待同步/最近同步：文案与基调正确", () => {
    expect(buildSpaceInfo(status(), settingsWithR2(true), { kind: "syncing" }).detail).toBe(
      SYNC_SYNCING_LABEL,
    );
    expect(
      buildSpaceInfo(status(), settingsWithR2(true), {
        kind: "idle",
        lastSyncAt: undefined,
      }).detail,
    ).toBe(SYNC_PENDING_LABEL);
    expect(
      buildSpaceInfo(status(), settingsWithR2(true), {
        kind: "idle",
        lastSyncAt: "2026-08-09T14:32:00.000Z",
      }).detail,
    ).toBe("最近同步 2026-08-09 14:32");
  });

  it("空间激活 + 同步失败：失败提示作副标题，警示基调", () => {
    const sync: CloudSyncStatus = {
      kind: "error",
      message: "R2 访问被拒绝（HTTP 403）",
      lastSyncAt: "2026-08-09T14:32:00.000Z",
    };
    const info = buildSpaceInfo(status(), settingsWithR2(true), sync);
    expect(info.detail).toBe(`云同步失败：${sync.message}`);
    expect(info.tone).toBe("warning");
  });

  it("从文件镜像恢复（ticket 16）：恢复标记与同步状态并列作副标题", () => {
    const restored = buildSpaceInfo(status({ restored: true }), DEFAULT_SETTINGS, {
      kind: "unconfigured",
    });
    expect(restored.detail).toBe(`已从文件镜像恢复 · ${SYNC_NOT_CONFIGURED_LABEL}`);
    const noSync = buildSpaceInfo(status({ restored: true }), settingsWithR2(true), {
      kind: "idle",
      lastSyncAt: undefined,
    });
    expect(noSync.detail).toBe(`已从文件镜像恢复 · ${SYNC_PENDING_LABEL}`);
  });

  it("未保存/空间缺失/绑定无法识别：humanMsg 作标题，警示基调", () => {
    for (const kind of ["unsaved-chat", "space-missing", "binding-unrecognized"] as const) {
      const info = buildSpaceInfo(
        { kind, humanMsg: `msg-${kind}` } as SpaceContextStatus,
        DEFAULT_SETTINGS,
        { kind: "unconfigured" },
      );
      expect(info).toEqual({ title: `msg-${kind}`, detail: "", tone: "warning" });
    }
  });

  it("状态未就绪（首次同步前）：加载中", () => {
    expect(buildSpaceInfo(undefined, DEFAULT_SETTINGS, { kind: "unconfigured" })).toEqual({
      title: "正在加载…",
      detail: "",
      tone: "muted",
    });
  });

  it("插件停用：头部直接提示停用（优先于空间状态）", () => {
    const info = buildSpaceInfo(
      status(),
      { ...DEFAULT_SETTINGS, enabled: false },
      {
        kind: "syncing",
      },
    );
    expect(info.title).toBe("插件已停用");
    expect(info.tone).toBe("muted");
  });
});

describe("syncStatusDetail / syncStatusSummary（同步状态文案）", () => {
  it("detail：未配置/同步中/待同步/最近同步/失败提示", () => {
    expect(syncStatusDetail({ kind: "unconfigured" })).toBe(SYNC_NOT_CONFIGURED_LABEL);
    expect(syncStatusDetail({ kind: "syncing" })).toBe(SYNC_SYNCING_LABEL);
    expect(syncStatusDetail({ kind: "idle", lastSyncAt: undefined })).toBe(SYNC_PENDING_LABEL);
    expect(syncStatusDetail({ kind: "idle", lastSyncAt: "2026-08-09T00:00:00.000Z" })).toBe(
      "最近同步 2026-08-09 00:00",
    );
    expect(syncStatusDetail({ kind: "error", message: "boom", lastSyncAt: undefined })).toBe(
      "云同步失败：boom",
    );
  });

  it("summary（设置面板状态行）：未配置给指引，失败含消息", () => {
    expect(syncStatusSummary({ kind: "unconfigured" })).toContain("未配置");
    expect(syncStatusSummary({ kind: "syncing" })).toBe("同步中…");
    expect(syncStatusSummary({ kind: "idle", lastSyncAt: "2026-08-09T00:00:00.000Z" })).toBe(
      "最近同步 2026-08-09 00:00",
    );
    expect(syncStatusSummary({ kind: "error", message: "boom", lastSyncAt: undefined })).toBe(
      "失败：boom",
    );
  });

  it("formatSyncTime：UTC 确定性切片（YYYY-MM-DD HH:mm）", () => {
    expect(formatSyncTime("2026-08-09T14:32:05.123Z")).toBe("2026-08-09 14:32");
    expect(formatSyncTime("2026-01-02T03:04:00.000Z")).toBe("2026-01-02 03:04");
  });
});

describe("mirrorStatusSummary（设置面板镜像状态行，ticket 16）", () => {
  it("停用/未写回/已写回（时间 + 体积）", () => {
    expect(mirrorStatusSummary({ kind: "disabled" })).toContain("已停用");
    expect(
      mirrorStatusSummary({ kind: "idle", lastWrittenAt: undefined, sizeBytes: undefined }),
    ).toBe("已启用（尚未写回）");
    expect(
      mirrorStatusSummary({
        kind: "idle",
        lastWrittenAt: "2026-08-10T01:02:03.000Z",
        sizeBytes: 15360,
      }),
    ).toBe("上次写回 2026-08-10 01:02 · 15.0 KB");
  });
});

describe("runtimeStatusLabel（设置面板运行状态行）", () => {
  it("各状态文案齐全", () => {
    expect(runtimeStatusLabel(undefined)).toBe("启动中…");
    expect(runtimeStatusLabel(status())).toBe("已加载 · 空间同步正常");
    expect(runtimeStatusLabel({ kind: "unsaved-chat", humanMsg: "x" } as SpaceContextStatus)).toBe(
      "已加载 · 当前对话未保存",
    );
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
