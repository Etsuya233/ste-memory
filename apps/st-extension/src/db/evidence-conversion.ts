import type { MemoryEvidence, MemorySpaceId } from "@ste-memory/core/memory";
import type { MemoryEvidenceRow } from "./database.ts";

/**
 * 证据行 ↔ 领域对象的转换（Dexie 行携带 id 主键与 memorySpaceId 作用域列，
 * 领域类型用 evidence_id 且不含空间字段，见 database.ts）。记录 repository 与
 * 备份 repository 共用，保证「快照证据缺少正文」损坏护栏行为一致。
 */

/** 领域证据 → Dexie 行（id 主键 + memorySpaceId 作用域列）。 */
export function toEvidenceRow(
  memorySpaceId: MemorySpaceId,
  evidence: MemoryEvidence,
): MemoryEvidenceRow {
  const { evidence_id: id, ...rest } = evidence;
  return { id, memorySpaceId, ...rest };
}

/** Dexie 行 → 领域证据；快照证据缺少正文视为存储损坏（与参照实现同语义）。 */
export function toDomainEvidence(row: MemoryEvidenceRow): MemoryEvidence {
  if (row.storage_mode === "snapshot" && row.content === null) {
    throw new Error("快照证据缺少正文");
  }
  return {
    evidence_id: row.id,
    source_type: row.source_type,
    source_id: row.source_id,
    storage_mode: row.storage_mode,
    ...(row.storage_mode === "snapshot" ? { content: row.content } : {}),
    extraProps: row.extraProps,
  } as MemoryEvidence;
}
