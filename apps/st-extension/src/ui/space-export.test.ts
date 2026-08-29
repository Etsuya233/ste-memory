import type { MemorySpaceId } from "@ste-memory/core/memory";
import type { MemoryBackupSnapshot, MemorySpaceBackup } from "@ste-memory/core/memory/export";
import { describe, expect, it } from "vitest";
import { buildSpaceExportUnit } from "./panel-shell.tsx";

function unit(spaceId: string, withHistory: boolean): MemorySpaceBackup {
  return {
    space: { id: spaceId as MemorySpaceId, name: `空间 ${spaceId}`, createdAt: "", updatedAt: "" },
    tables: [],
    fields: [],
    records: [],
    history: withHistory
      ? [
          {
            id: "h1",
            recordId: "r1",
            memorySpaceId: spaceId as MemorySpaceId,
            tableId: "t1",
            payload: {},
            fieldEvidence: {},
            displayText: "",
            source: { type: "manual" },
            previousRevisionId: "p",
            previousRevisionSource: "user",
            revisionId: "rev",
            revisionSource: "user",
            createdAt: "",
            updatedAt: "",
            archivedAt: "",
          } as MemorySpaceBackup["history"][number],
        ]
      : [],
    evidence: [],
  };
}

describe("buildSpaceExportUnit（issue 26 导出快照过滤）", () => {
  const snapshot: MemoryBackupSnapshot = {
    spaces: [unit("A", true), unit("B", true)],
  };

  it("只含当前空间单元（从全库快照滤出当前 spaceId）", () => {
    const result = buildSpaceExportUnit(snapshot, "A" as MemorySpaceId, true);
    expect(result).not.toBeNull();
    expect(result?.space.id).toBe("A");
    // 不包含其他空间的数据
    expect(result?.space.id === "B").toBe(false);
  });

  it("当前空间不在快照中时返回 null（导出前校验）", () => {
    expect(buildSpaceExportUnit(snapshot, "Z" as MemorySpaceId, true)).toBeNull();
  });

  it("includeHistory=true：保留修订历史", () => {
    const result = buildSpaceExportUnit(snapshot, "A" as MemorySpaceId, true);
    expect(result?.history).toHaveLength(1);
  });

  it("includeHistory=false：裁剪修订历史（用户 story 5 跟随设置项）", () => {
    const result = buildSpaceExportUnit(snapshot, "A" as MemorySpaceId, false);
    expect(result?.history).toHaveLength(0);
    // 其余数据保留
    expect(result?.space.id).toBe("A");
  });
});
