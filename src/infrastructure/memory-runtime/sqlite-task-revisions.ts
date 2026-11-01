import type { MemorySpaceBackup } from "../../features/backup/backup-file.ts";
import type {
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRevisionId,
} from "../../features/memory/index.ts";
import type { SqliteMemoryStore } from "./sqlite-memory-store.ts";

/** 从批次开始状态计算最终修订，再在当前任务事务内一起替换中间修订。 */
export async function consolidateTaskRevisions(
  memory: SqliteMemoryStore,
  baseline: MemorySpaceBackup,
  token: symbol,
  revisionId: MemoryRevisionId,
  archivedAt: string,
): Promise<void> {
  const id = baseline.space.id;
  memory.assertWritable(id, token);
  const current = await memory.client.exportSpace(id, "write");
  const revision = taskRevisionChanges(baseline, current, revisionId, archivedAt);
  const evidenceIds = discardedTaskEvidence(baseline, current, revision.intermediateHistory);
  await memory.write(
    id,
    async () => {
      for (const item of revision.intermediateHistory)
        await memory.client.deleteEntity(id, "history", item.id);
      for (const record of revision.records) await memory.client.putEntity(id, "record", record);
      for (const history of revision.history) await memory.client.putEntity(id, "history", history);
      for (const evidenceId of evidenceIds)
        await memory.client.deleteEntity(id, "evidence", evidenceId);
    },
    token,
  );
}

function taskRevisionChanges(
  baseline: MemorySpaceBackup,
  current: MemorySpaceBackup,
  revisionId: MemoryRevisionId,
  archivedAt: string,
) {
  const previousRecords = new Map(baseline.records.map((record) => [record.id, record]));
  const currentRecords = new Map(current.records.map((record) => [record.id, record]));
  const oldHistoryIds = new Set(baseline.history.map((item) => item.id));
  const intermediateHistory = current.history.filter((item) => !oldHistoryIds.has(item.id));
  const records: MemoryRecord[] = [];
  const history: MemoryRecordHistory[] = [];
  for (const key of new Set([...previousRecords.keys(), ...currentRecords.keys()])) {
    const previous = previousRecords.get(key);
    const record = currentRecords.get(key);
    if (previous && record && sameRecordState(previous, record)) {
      if (previous.revisionId !== record.revisionId) records.push(previous);
      continue;
    }
    if (record) records.push({ ...record, revisionId, revisionSource: "agent" });
    if (!previous) continue;
    const first = intermediateHistory.find((item) => item.recordId === key);
    if (!first) throw new Error("任务修订缺少原记录历史");
    history.push({
      ...first,
      ...previous,
      id: first.id,
      recordId: previous.id,
      previousRevisionId: previous.revisionId,
      previousRevisionSource: previous.revisionSource,
      revisionId,
      revisionSource: "agent",
      archivedAt,
    });
  }
  return { intermediateHistory, records, history };
}

function sameRecordState(left: MemoryRecord, right: MemoryRecord): boolean {
  // 空证据集合和键插入顺序都不代表内容变化，撤回到原值时保留原修订。
  const state = (record: MemoryRecord) =>
    JSON.stringify([
      Object.fromEntries(Object.entries(record.payload).sort(([a], [b]) => a.localeCompare(b))),
      Object.fromEntries(
        Object.entries(record.fieldEvidence)
          .filter(([, entries]) => entries.length > 0)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
      record.displayText,
      record.source,
    ]);
  return state(left) === state(right);
}

function discardedTaskEvidence(
  baseline: MemorySpaceBackup,
  current: MemorySpaceBackup,
  intermediateHistory: readonly MemoryRecordHistory[],
) {
  // 只回收本批新建后删除的记录所独占的证据；批次输入证据可以没有字段引用。
  const previousRecords = new Set(baseline.records.map((record) => record.id));
  const currentRecords = new Set(current.records.map((record) => record.id));
  const transient = new Set(
    intermediateHistory
      .filter((item) => !previousRecords.has(item.recordId) && !currentRecords.has(item.recordId))
      .flatMap((item) =>
        Object.values(item.fieldEvidence)
          .flat()
          .map((entry) => entry.evidence_id),
      ),
  );
  const retained = new Set(
    current.records.flatMap((record) =>
      Object.values(record.fieldEvidence)
        .flat()
        .map((entry) => entry.evidence_id),
    ),
  );
  const oldEvidence = new Set(baseline.evidence.map((entry) => entry.evidence_id));
  return current.evidence
    .filter(
      (entry) =>
        transient.has(entry.evidence_id) &&
        !retained.has(entry.evidence_id) &&
        !oldEvidence.has(entry.evidence_id),
    )
    .map((entry) => entry.evidence_id);
}
