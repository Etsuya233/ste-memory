import type { Transaction } from "dexie";
import { migrateMemorySpaceSnapshot } from "../../features/memory-snapshot/snapshot-migration.ts";
import type { MemorySpaceBackup } from "../../features/memory-snapshot/snapshot.ts";
import type { MemoryEvidenceRow } from "./database.ts";
import { toDomainSpace, type MemorySpaceRow } from "./memory/space-row.ts";
import { toDomainEvidence } from "./memory/evidence-conversion.ts";

/** Dexie 升级事务先组合旧快照，统一迁移后写回；异常会让整个版本升级回滚。 */
export async function upgradeLocalMemorySnapshots(transaction: Transaction): Promise<void> {
  const [spaces, tables, fields, records, history, evidence] = await Promise.all([
    transaction.table<MemorySpaceRow>("memorySpaces").toArray(),
    transaction.table<MemorySpaceBackup["tables"][number]>("memoryTables").toArray(),
    transaction.table<MemorySpaceBackup["fields"][number]>("memoryFields").toArray(),
    transaction.table<MemorySpaceBackup["records"][number]>("memoryRecords").toArray(),
    transaction.table<MemorySpaceBackup["history"][number]>("memoryRecordHistory").toArray(),
    transaction.table<MemoryEvidenceRow>("memoryEvidence").toArray(),
  ]);
  // 本地旧行沿用 v5 的创建时间 / ID 顺序；文件旧快照沿用文件数组顺序。
  tables.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  for (const row of spaces) {
    const space = toDomainSpace(row);
    const unit = migrateMemorySpaceSnapshot({
      version:
        row.snapshotSchemaVersion === undefined ? "legacy-macros" : row.snapshotSchemaVersion,
      snapshot: {
        ...(row.snapshotSchemaVersion === undefined
          ? {}
          : { schemaVersion: row.snapshotSchemaVersion }),
        space,
        tables: tables.filter((table) => table.memorySpaceId === space.id),
        fields: fields.filter((field) => field.memorySpaceId === space.id),
        records: records.filter((record) => record.memorySpaceId === space.id),
        history: history.filter((item) => item.memorySpaceId === space.id),
        evidence: evidence.filter((item) => item.memorySpaceId === space.id).map(toDomainEvidence),
      },
    });
    await transaction
      .table("memorySpaces")
      .put({ ...unit.space, snapshotSchemaVersion: unit.schemaVersion });
    await transaction.table("memoryTables").bulkPut([...unit.tables]);
    await transaction.table("memoryRecords").bulkPut([...unit.records]);
  }
}
