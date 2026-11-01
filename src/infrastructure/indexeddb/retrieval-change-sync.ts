import type { VectorRetrievalService } from "../../features/vector-retrieval/vector-retrieval-service.ts";
import type { SteMemoryDatabase } from "./database.ts";

/** 向量存储变更只通知检索的索引覆盖；记忆内容由SQLite已提交事件通知。 */
export function trackRetrievalChanges(
  db: SteMemoryDatabase,
  retrieval: VectorRetrievalService,
): void {
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
