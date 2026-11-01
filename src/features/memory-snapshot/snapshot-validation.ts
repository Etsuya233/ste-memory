import { memorySpaceSnapshotSchema } from "./snapshot-schema.ts";
import type { MemorySpaceBackup } from "./snapshot.ts";
import { createSnapshotSeenIds, validateSnapshotIntegrity } from "./snapshot-integrity.ts";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import { snapshotInvalid } from "./snapshot-errors.ts";

export function assertSnapshotStructure(schema: TSchema, value: unknown): void {
  if (Value.Check(schema, value)) {
    return;
  }
  const details = [...Value.Errors(schema, value)]
    .slice(0, 5)
    .map(
      (error) =>
        `${(error.instancePath || "文件顶层")
          .replace(/^\//, "")
          .replace(/\/(\d+)/g, "[$1]")
          .replaceAll("/", ".")}: ${error.message}`,
    )
    .join("；");
  snapshotInvalid(details);
}

/** 当前结构与完整性共同构成加载边界；此处恢复 JSON 字符串对应的领域品牌。 */
export function validateCurrentSnapshot(snapshot: unknown): MemorySpaceBackup {
  assertSnapshotStructure(memorySpaceSnapshotSchema, snapshot);
  const current = snapshot as MemorySpaceBackup;
  validateSnapshotIntegrity(current, createSnapshotSeenIds());
  return current;
}
