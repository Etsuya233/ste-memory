import type { MemorySpaceId } from "../memory/index.ts";
import type { MemoryBackupSnapshot, MemorySpaceBackup } from "./index.ts";
import { describe, expect, it, vi } from "vitest";
import { buildSpaceExportUnit, executeFullBackupImport } from "./space-transfer.ts";

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
        id: "macro-1",
        name: "未完成伏笔",
        enabled: true,
        expression: {
          language: "query",
          query: {
            table: "plots",
            conditions: [{ field: "status", op: "in", value: ["埋设中"] }],
            limit: 20,
          },
        },
        output: { format: "text", maxChars: null },
      },
    ]);

    expect(result?.fillTasks).toHaveLength(1);
    expect(result?.floorLedger).toEqual([{ floor: 0, status: "processed", updatedAt: "" }]);
    expect(result?.space.macros).toEqual([
      {
        id: "macro-1",
        name: "未完成伏笔",
        enabled: true,
        expression: {
          language: "query",
          query: {
            table: "plots",
            conditions: [{ field: "status", op: "in", value: ["埋设中"] }],
            limit: 20,
          },
        },
        output: { format: "text", maxChars: null },
      },
    ]);
  });

  it("未传宏覆盖参数时保留空间已有宏，不导出独立旧集合", () => {
    const result = buildSpaceExportUnit(snapshot, "A" as MemorySpaceId, true);
    expect(result?.space.macros).toEqual(snapshot.spaces[0]!.space.macros);
    expect(result).not.toHaveProperty("chatScopeMacros");
  });
});

describe("executeFullBackupImport", () => {
  it("所有空间完成编译后原子恢复，并依据可信分类关闭空间及旧对话语义宏", async () => {
    const original = unit("A", false);
    const macro = {
      id: "semantic",
      name: "语义",
      enabled: true,
      expression: { language: "sql" as const, sql: "SELECT 1", usesSemantic: false },
      output: { format: "json" as const, maxChars: null },
    };
    const source = {
      ...original,
      space: { ...original.space, macros: [macro] },
      chatScopeMacros: [macro],
    };
    const restoreSnapshot = vi.fn(async (_snapshot: MemoryBackupSnapshot) => {});
    const normalizeImportedSpace = vi.fn(async (input: MemorySpaceBackup) => ({
      ...input,
      space: {
        ...input.space,
        macros: [{ ...macro, expression: { ...macro.expression, usesSemantic: true } }],
      },
      chatScopeMacros: [{ ...macro, expression: { ...macro.expression, usesSemantic: true } }],
    }));
    await executeFullBackupImport(
      { kind: "ready", data: { spaces: [source] }, spaceCount: 1, confirmMessage: "" },
      {
        backup: { restoreSnapshot },
        normalizeImportedSpace,
        syncToCurrentChat: async () => {},
        kickMacros: () => {},
        onDataChanged: () => {},
      },
    );
    expect(normalizeImportedSpace).toHaveBeenCalledWith(source);
    const restored = restoreSnapshot.mock.calls[0]!;
    expect(restored[0].spaces[0]!.space.macros![0]!.enabled).toBe(false);
    expect(restored[0].spaces[0]!.chatScopeMacros![0]!.enabled).toBe(false);
    expect(macro.enabled).toBe(true);
  });

  it("任一空间编译失败保留原库，不能先恢复其他空间", async () => {
    const restoreSnapshot = vi.fn(async (_snapshot: MemoryBackupSnapshot) => {});
    await expect(
      executeFullBackupImport(
        {
          kind: "ready",
          data: { spaces: [unit("A", false), unit("B", false)] },
          spaceCount: 2,
          confirmMessage: "",
        },
        {
          backup: { restoreSnapshot },
          normalizeImportedSpace: async (input) => {
            if (input.space.id === "B") throw new Error("表不存在");
            return input;
          },
          syncToCurrentChat: async () => {},
          kickMacros: () => {},
          onDataChanged: () => {},
        },
      ),
    ).rejects.toThrow("表不存在");
    expect(restoreSnapshot).not.toHaveBeenCalled();
  });
});
