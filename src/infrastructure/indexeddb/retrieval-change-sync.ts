import type { Transaction } from "dexie";
import type { VectorRetrievalService } from "../../features/vector-retrieval/vector-retrieval-service.ts";
import type { MemorySpaceId } from "../../features/memory/index.ts";
import type { SteMemoryDatabase } from "./database.ts";

/** 已提交记忆变更与索引删除立即使页面查询失效，新增向量仅提示重搜。 */
export function trackRetrievalChanges(
  db: SteMemoryDatabase,
  retrieval: VectorRetrievalService,
): void {
  const memoryChanged = (spaceId: MemorySpaceId, tx: Transaction) => {
    tx.on("complete", () => retrieval.invalidate(spaceId));
  };
  db.memorySpaces.hook("updating", (_changes, _key, row, tx) => memoryChanged(row.id, tx));
  db.memorySpaces.hook("deleting", (_key, row, tx) => memoryChanged(row.id, tx));
  db.memoryTables.hook("creating", (_key, row, tx) => memoryChanged(row.memorySpaceId, tx));
  db.memoryTables.hook("updating", (_changes, _key, row, tx) =>
    memoryChanged(row.memorySpaceId, tx),
  );
  db.memoryTables.hook("deleting", (_key, row, tx) => memoryChanged(row.memorySpaceId, tx));
  db.memoryFields.hook("creating", (_key, row, tx) => memoryChanged(row.memorySpaceId, tx));
  db.memoryFields.hook("updating", (_changes, _key, row, tx) =>
    memoryChanged(row.memorySpaceId, tx),
  );
  db.memoryFields.hook("deleting", (_key, row, tx) => memoryChanged(row.memorySpaceId, tx));
  db.memoryRecords.hook("creating", (_key, row, tx) => memoryChanged(row.memorySpaceId, tx));
  db.memoryRecords.hook("updating", (_changes, _key, row, tx) =>
    memoryChanged(row.memorySpaceId, tx),
  );
  db.memoryRecords.hook("deleting", (_key, row, tx) => memoryChanged(row.memorySpaceId, tx));
  db.recordVectors.hook("creating", (_key, row, tx) => {
    tx.on("complete", () => retrieval.indexChanged(row, false));
  });
  db.recordVectors.hook("updating", (changes, _key, row, tx) => {
    const replaced =
      ("fingerprint" in changes && changes.fingerprint !== row.fingerprint) ||
      ("model" in changes && changes.model !== row.model) ||
      ("version" in changes && changes.version !== row.version);
    tx.on("complete", () => retrieval.indexChanged(row, replaced));
  });
  db.recordVectors.hook("deleting", (_key, row, tx) => {
    tx.on("complete", () => retrieval.indexChanged(row, true));
  });
}
