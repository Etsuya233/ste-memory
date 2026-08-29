import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { MemoryBackupFile, MemorySpaceBackup } from "@ste-memory/core/memory/export";
import type { ChatSpaceBinding } from "./chat-space-manager.ts";
import { describe, expect, it } from "vitest";
import { resolveImportAction } from "./import-action.ts";

/** 造一个最小可序列化的单空间单元（解析器只读取 unit.space.id）。 */
function unit(spaceId: string): MemorySpaceBackup {
  return {
    space: { id: spaceId as MemorySpaceId, name: `空间 ${spaceId}`, createdAt: "", updatedAt: "" },
    tables: [],
    fields: [],
    records: [],
    history: [],
    evidence: [],
  };
}

function file(spaces: MemorySpaceBackup[]): MemoryBackupFile {
  return {
    format: "ste-memory-backup",
    version: 1,
    exportedAt: "2026-08-30T00:00:00.000Z",
    appVersion: "0.1.0",
    data: { spaces },
  };
}

const bound = (spaceId: string): ChatSpaceBinding => ({
  version: 2,
  spaceId: spaceId as ChatSpaceBinding["spaceId"],
  chatIdentity: "char:1:chat",
});

describe("resolveImportAction（issue 26 单空间导入动作解析器）", () => {
  it("restore：绑定存在且文件含匹配 spaceId → 返回匹配的单元", () => {
    const result = resolveImportAction(file([unit("A"), unit("B")]), bound("A"));
    expect(result).toEqual({ kind: "restore", unit: unit("A") });
  });

  it("restore：全库多空间文件中也能按当前 spaceId 提取匹配单元", () => {
    const result = resolveImportAction(
      file([unit("X"), unit("Y"), unit("Z")]),
      bound("Y"),
    );
    expect(result).toEqual({ kind: "restore", unit: unit("Y") });
  });

  it("clone-and-rebind：绑定存在但无 id 匹配，且文件为单空间单元", () => {
    const result = resolveImportAction(file([unit("OTHER")]), bound("CURRENT"));
    expect(result).toEqual({
      kind: "clone-and-rebind",
      unit: unit("OTHER"),
      currentSpaceId: "CURRENT",
    });
  });

  it("create-and-bind：无绑定且文件为单空间单元", () => {
    const result = resolveImportAction(file([unit("LONE")]), null);
    expect(result).toEqual({ kind: "create-and-bind", unit: unit("LONE") });
  });

  it("no-match：绑定存在且多空间文件无 id 匹配 → 报错（无法决定克隆哪一个）", () => {
    const result = resolveImportAction(file([unit("P"), unit("Q")]), bound("R"));
    expect(result).toEqual({
      kind: "no-match",
      availableSpaceIds: ["P", "Q"].map((id) => id as MemorySpaceId),
    });
  });

  it("no-match：无绑定且多空间文件 → 报错（无法决定绑定哪一个）", () => {
    const result = resolveImportAction(file([unit("P"), unit("Q")]), null);
    expect(result).toEqual({
      kind: "no-match",
      availableSpaceIds: ["P", "Q"].map((id) => id as MemorySpaceId),
    });
  });

  it("no-match：空文件（无单元）→ 报错", () => {
    const result = resolveImportAction(file([]), bound("A"));
    expect(result).toEqual({ kind: "no-match", availableSpaceIds: [] });
  });
});
