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
      normalizeImportedSpace: async (unit) => unit,
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
  it.each([false, true])(
    "分支绑定与备份空间 ID 相同也克隆重绑（多空间文件：%s）",
    async (multiple) => {
      const source = unit("A");
      const text = serializeBackupFile(
        createBackupFile(
          { spaces: multiple ? [unit("B"), source] : [source] },
          "0.2.4",
          "2026-10-31T00:00:00.000Z",
        ),
      );
      const plan = planSpaceImport(text, {
        kind: "branch-detected",
        binding: { version: 2, spaceId: source.space.id, chatIdentity: "char:10:original" },
        space: source.space,
        originalChatIdentity: "char:10:original",
      });
      expect(plan.kind).toBe("ready");
      if (plan.kind !== "ready") throw new Error("expect ready");
      expect(plan.action).toMatchObject({
        kind: "clone-and-rebind",
        unit: source,
        currentSpaceId: source.space.id,
      });
      expect(plan.confirmMessage).toContain("将创建新的记忆空间并绑定到当前对话");
      const harness = deps();
      await executeSpaceImport(plan, harness.deps);
      expect(harness.importSpace).toHaveBeenCalledWith(
        expect.objectContaining({ space: expect.objectContaining(source.space) }),
      );
      expect(harness.restoreSpace).not.toHaveBeenCalled();
    },
  );

  it("导入先编译分类再关闭语义宏，伪造false不能绕过且普通SQL保持启用", async () => {
    const source = unit("A");
    const macros = [true, false].map((semantic, index) => ({
      id: `macro-${index}`,
      name: `宏${index}`,
      enabled: true,
      expression: {
        language: "sql" as const,
        sql: semantic ? "SELECT * FROM semantic_scores('t','[]','q')" : "SELECT 1",
        usesSemantic: false,
      },
      output: { format: "json" as const, maxChars: null },
    }));
    const plan = planSpaceImport(
      fileText({ ...source, space: { ...source.space, macros } }),
      activeStatus("A"),
    );
    if (plan.kind !== "ready") throw new Error("expect ready");
    const harness = deps({
      normalizeImportedSpace: async (unit) => ({
        ...unit,
        space: {
          ...unit.space,
          macros: unit.space.macros!.map((macro, index) => ({
            ...macro,
            expression: { ...macro.expression, usesSemantic: index === 0 },
          })),
        },
      }),
    });
    await executeSpaceImport(plan, harness.deps);
    expect(harness.restoreSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        space: expect.objectContaining({
          macros: [
            expect.objectContaining({
              enabled: false,
              expression: expect.objectContaining({ usesSemantic: true }),
            }),
            expect.objectContaining({
              enabled: true,
              expression: expect.objectContaining({ usesSemantic: false }),
            }),
          ],
        }),
      }),
    );
  });

  it("编译失败不会恢复或克隆空间", async () => {
    const plan = planSpaceImport(fileText(unit("A")), activeStatus("A"));
    if (plan.kind !== "ready") throw new Error("expect ready");
    const harness = deps({
      normalizeImportedSpace: async () => {
        throw new Error("SQL依赖无效");
      },
    });
    await expect(executeSpaceImport(plan, harness.deps)).rejects.toThrow("SQL依赖无效");
    expect(harness.restoreSpace).not.toHaveBeenCalled();
    expect(harness.importSpace).not.toHaveBeenCalled();
  });

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
