import type { MemorySpace, MemorySpaceId } from "../../../features/memory/index.ts";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../../features/settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../../../features/chat-binding/chat-space-manager.ts";
import {
  buildSpaceInfo,
  formatDisplayTime,
  mirrorStatusSummary,
  runtimeStatusLabel,
} from "./space-info.ts";

function space(overrides: Partial<MemorySpace> = {}): MemorySpace {
  return {
    id: "space-1" as MemorySpaceId,
    name: "爱丽丝 - story",
    initializationSource: null,
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

describe("buildSpaceInfo（面板头部：空间名 + 状态）", () => {
  it("空间激活：名称 + 空副标题", () => {
    expect(buildSpaceInfo(status(), DEFAULT_SETTINGS)).toEqual({
      title: "爱丽丝 - story",
      detail: "",
      tone: "normal",
    });
  });

  it("从文件镜像恢复（ticket 16）：恢复标记作副标题", () => {
    expect(buildSpaceInfo(status({ restored: true }), DEFAULT_SETTINGS).detail).toBe(
      "已从文件镜像恢复",
    );
  });

  it("分支对话检测：警示基调", () => {
    const branch = buildSpaceInfo(
      {
        kind: "branch-detected",
        binding: { version: 1, spaceId: "space-1" as MemorySpaceId },
        space: space(),
        originalChatIdentity: "chat-a",
      } as SpaceContextStatus,
      DEFAULT_SETTINGS,
    );
    expect(branch.title).toBe("爱丽丝 - story");
    expect(branch.detail).toBe("检测到分支对话（原归属: chat-a）");
    expect(branch.tone).toBe("warning");
  });

  it("未保存/空间缺失/绑定无法识别：humanMsg 作标题，警示基调", () => {
    for (const kind of ["unsaved-chat", "space-missing", "binding-unrecognized"] as const) {
      const info = buildSpaceInfo({ kind, humanMsg: `msg-${kind}` } as SpaceContextStatus, {
        ...DEFAULT_SETTINGS,
      });
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

describe("formatDisplayTime：UTC 确定性切片（YYYY-MM-DD HH:mm）", () => {
  it("毫秒与秒都截断到分钟", () => {
    expect(formatDisplayTime("2026-08-09T14:32:05.123Z")).toBe("2026-08-09 14:32");
    expect(formatDisplayTime("2026-01-02T03:04:00.000Z")).toBe("2026-01-02 03:04");
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
