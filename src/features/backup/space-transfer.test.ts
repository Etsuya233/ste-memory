import type { MemorySpaceId } from "../memory/index.ts";
import type { MemoryBackupSnapshot, MemorySpaceBackup } from "./index.ts";
import { describe, expect, it } from "vitest";
import { buildSpaceExportUnit } from "./space-transfer.ts";

function unit(spaceId: string, withHistory: boolean): MemorySpaceBackup {
  return {
    space: {
      id: spaceId as MemorySpaceId,
      name: `空间 ${spaceId}`,
      initializationSource: null,
      createdAt: "",
      updatedAt: "",
    },
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

  it("保留单元的任务与楼层进度，并写入导出时该对话的对话级宏（spec 6.3）", () => {
    const withRuntimeRows = {
      ...unit("A", true),
      fillTasks: [
        {
          runId: "run-1",
          memorySpaceId: "A" as MemorySpaceId,
          from: 0,
          to: 5,
          blockSize: 20,
          kind: "floor" as const,
          initText: null,
          chatId: "story",
          status: "succeeded" as const,
          errorMessage: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
      floorLedger: [{ floor: 0, status: "processed" as const, updatedAt: "" }],
    };

    const result = buildSpaceExportUnit({ spaces: [withRuntimeRows] }, "A" as MemorySpaceId, true, [
      {
        name: "未完成伏笔",
        tableKey: "plots",
        condition: { fieldKey: "status", values: ["埋设中"] },
        limit: 20,
        projection: [],
      },
    ]);

    expect(result?.fillTasks).toHaveLength(1);
    expect(result?.floorLedger).toEqual([{ floor: 0, status: "processed", updatedAt: "" }]);
    expect(result?.chatScopeMacros).toEqual([
      {
        name: "未完成伏笔",
        tableKey: "plots",
        condition: { fieldKey: "status", values: ["埋设中"] },
        limit: 20,
        projection: [],
      },
    ]);
  });

  it("未传对话级宏时导出宏为空数组（不涉及当前对话的宏设置）", () => {
    const result = buildSpaceExportUnit(snapshot, "A" as MemorySpaceId, true);
    expect(result?.chatScopeMacros).toEqual([]);
  });
});
