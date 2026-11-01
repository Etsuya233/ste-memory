import type { MemorySpace } from "../../../features/memory/index.ts";

/** 版本属于本地快照存储协议，不进入领域对象或文件快照中的 space。 */
export type MemorySpaceRow = MemorySpace & { readonly snapshotSchemaVersion?: number };

export function toDomainSpace({
  snapshotSchemaVersion: _version,
  ...space
}: MemorySpaceRow): MemorySpace {
  return space;
}
