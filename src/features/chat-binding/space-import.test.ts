import type { MemorySpaceId } from "../memory/index.ts";
import type { MemoryBackupRepository } from "../backup/index.ts";
import type { SpaceContextStatus } from "./chat-space-manager.ts";
import { describe, expect, it, vi } from "vitest";
import { createBackupFile, serializeBackupFile } from "../backup/index.ts";
import {
  executeSpaceImport,
  planSpaceImport,
  type SpaceImportExecutionDeps,
} from "./space-import.ts";
import type { MemorySpaceBackup } from "../backup/index.ts";

function unit(spaceId: string, overrides: Partial<MemorySpaceBackup> = {}): MemorySpaceBackup {
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
    history: [],
    evidence: [],
    ...overrides,
  };
}

function fileText(space: MemorySpaceBackup): string {
  return serializeBackupFile(
    createBackupFile({ spaces: [space] }, "0.1.0", "2026-10-18T00:00:00.000Z"),
  );
}

function activeStatus(spaceId: string): SpaceContextStatus {
  return {
    kind: "active",
    binding: { version: 2, spaceId: spaceId as MemorySpaceId, chatIdentity: "char:1:chat" },
    space: unit(spaceId).space,
    created: false,
    restored: false,
  };
}

function deps(overrides: Partial<SpaceImportExecutionDeps> = {}): {
  readonly deps: SpaceImportExecutionDeps;
  readonly restoreSpace: ReturnType<typeof vi.fn>;
  readonly importSpace: ReturnType<typeof vi.fn>;
  readonly writeChatScopeMacros: ReturnType<typeof vi.fn>;
} {
  const restoreSpace = vi.fn(async () => undefined);
  const importSpace = vi.fn(async () => undefined);
  const writeChatScopeMacros = vi.fn();
  return {
    restoreSpace,
    importSpace,
    writeChatScopeMacros,
    deps: {
      backup: { restoreSpace } as unknown as Pick<MemoryBackupRepository, "restoreSpace">,
      manager: {
        importSpace,
        syncToCurrentChat: vi.fn(async () => undefined),
      },
      kickMacros: vi.fn(),
      kickMirror: vi.fn(),
      onDataChanged: vi.fn(),
      writeChatScopeMacros,
      ...overrides,
    },
  };
}

describe("space-import（单空间导入编排，issue 26）", () => {
  it("restore：绑定匹配 → 恢复当前空间并重同步", async () => {
    const plan = planSpaceImport(fileText(unit("A")), activeStatus("A"));
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    const harness = deps();

    await executeSpaceImport(plan, harness.deps);

    expect(harness.restoreSpace).toHaveBeenCalledTimes(1);
    expect(harness.importSpace).not.toHaveBeenCalled();
  });

  it("clone-and-rebind：spaceId 不匹配 → 克隆新空间并重绑", async () => {
    const plan = planSpaceImport(fileText(unit("OTHER")), activeStatus("CURRENT"));
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    const harness = deps();

    await executeSpaceImport(plan, harness.deps);

    expect(harness.importSpace).toHaveBeenCalledTimes(1);
    expect(harness.restoreSpace).not.toHaveBeenCalled();
  });

  it("新文件的宏随空间恢复，不再写回独立聊天元数据", async () => {
    const macros = [
      {
        id: "m1",
        name: "纪要",
        enabled: true,
        expression: { language: "sql" as const, sql: "SELECT 1" },
        output: { format: "markdown" as const, maxChars: null },
      },
    ];
    const source = unit("A");
    const plan = planSpaceImport(
      fileText({ ...source, space: { ...source.space, macros } }),
      activeStatus("A"),
    );
    if (plan.kind !== "ready") throw new Error("expect ready");
    const harness = deps();
    await executeSpaceImport(plan, harness.deps);
    expect(harness.restoreSpace).toHaveBeenCalledWith(
      expect.objectContaining({ space: expect.objectContaining({ macros }) }),
    );
    expect(harness.writeChatScopeMacros).not.toHaveBeenCalled();
  });
});
