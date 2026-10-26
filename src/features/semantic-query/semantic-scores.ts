import type { MemorySpaceBackup } from "../backup/backup-file.ts";
import { effectiveVectorIndexGroups, type MemoryRecord } from "../memory/index.ts";
import type {
  VectorEmbeddingPort,
  VectorIndexRepository,
  RecordVector,
} from "../vector-index/index.ts";
import type { QueryVectorExecution } from "./query-vector-cache.ts";
import type { SemanticScoreRow, SemanticSqlSourceRequest } from "./semantic-sql-port.ts";

export interface SemanticScoreResult {
  readonly table: string;
  readonly query: string;
  readonly groups: readonly string[];
  readonly coverage: {
    records: number;
    expected: number;
    ready: number;
    empty: number;
    missing: number;
    stale: number;
    invalid: number;
  };
  readonly rows: readonly SemanticScoreRow[];
  readonly calls: number;
  readonly executionHits: number;
  readonly sharedHits: number;
}
export function semanticSourceKey(source: SemanticSqlSourceRequest): string {
  return JSON.stringify([source.table, [...source.groups].sort(), source.query.trim()]);
}
function norm(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum = Math.hypot(sum, value);
  return sum;
}
function valid(values: readonly number[]): boolean {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every(Number.isFinite) &&
    norm(values) > 0 &&
    Number.isFinite(norm(values))
  );
}

export function createSemanticScores(input: {
  snapshot: MemorySpaceBackup;
  vectors: Pick<VectorIndexRepository, "listVectors">;
  embedding: VectorEmbeddingPort;
  queryVectors: QueryVectorExecution;
  signal: AbortSignal;
  deadline: number;
}) {
  const { snapshot, vectors, embedding, queryVectors, signal, deadline } = input;
  const profile = structuredClone(embedding.getProfile());
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new DOMException("语义评分超时", "TimeoutError");
  };
  const yieldExecution = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    check();
  };
  const stored = new Map<string, Promise<RecordVector[]>>();
  const scores = new Map<string, Promise<SemanticScoreResult>>();
  function sourceMetadata(source: Pick<SemanticSqlSourceRequest, "table" | "groups">) {
    const table = snapshot.tables.find((table) => table.key === source.table && table.enabled);
    if (!table) throw new Error(`语义源的表不存在或已停用：${source.table}`);
    if (!table.vectorIndex?.enabled) throw new Error(`表未启用向量索引：${source.table}`);
    const fields = snapshot.fields.filter((field) => field.tableId === table.id);
    const groups = effectiveVectorIndexGroups(table.vectorIndex, fields);
    const selected = source.groups.map((key) => {
      const group = groups.find((group) => group.key === key);
      if (
        !group ||
        !group.fieldIds.length ||
        group.fieldIds.some((id) => !fields.some((field) => field.id === id && field.enabled))
      )
        throw new Error(`语义源分组不存在或字段无效：${source.table}/${key}`);
      return group;
    });
    if (!selected.length) throw new Error("语义源至少需要一个分组");
    return { table, fields, selected };
  }
  async function scoreSource(source: SemanticSqlSourceRequest): Promise<SemanticScoreResult> {
    check();
    const { table, fields, selected } = sourceMetadata(source);
    const query = source.query.trim();
    if (!query) throw new Error("语义查询文本为空或缺少最后用户消息");
    if (query.length > 4000) throw new Error("语义查询文本超过 4000 字符");
    const records = snapshot.records.filter((record) => record.tableId === table.id);
    const coverage = {
      records: records.length,
      expected: 0,
      ready: 0,
      empty: 0,
      missing: 0,
      stale: 0,
      invalid: 0,
    };
    const result: SemanticScoreResult = {
      table: source.table,
      query,
      groups: source.groups,
      coverage,
      rows: [],
      calls: 0,
      executionHits: 0,
      sharedHits: 0,
    };
    if (!records.length) return result;
    if (!stored.has(table.id))
      stored.set(
        table.id,
        vectors
          .listVectors({ memorySpaceId: snapshot.space.id, tableId: table.id })
          .then((rows) => structuredClone(rows)),
      );
    const recordIds = new Set(records.map((record) => record.id));
    const groupIds = new Set(selected.map((group) => group.id));
    const raw = (await stored.get(table.id)!).filter(
      (vector) => groupIds.has(vector.groupId) && recordIds.has(vector.recordId),
    );
    check();
    if (raw.length && !profile) throw new Error("已有存储向量，但尚未配置 embedding 连接");
    if (raw.length && profile && query.length > profile.maxInputChars)
      throw new Error("语义查询文本超过连接输入限制");
    const byTarget = new Map(
      raw.map((vector) => [JSON.stringify([vector.recordId, vector.groupId]), vector]),
    );
    const candidates: { record: MemoryRecord; groupKey: string; vector: RecordVector }[] = [];
    for (let i = 0; i < records.length; i++) {
      if (i % 100 === 0) await yieldExecution();
      const record = records[i]!;
      for (const group of selected) {
        const lines: string[] = [];
        let brokenReference = false;
        for (const id of group.fieldIds) {
          const field = fields.find((field) => field.id === id)!;
          const value = record.payload[id];
          if (
            value === null ||
            value === undefined ||
            value === "" ||
            (Array.isArray(value) && !value.length)
          )
            continue;
          let text: string;
          if (field.type === "single_reference" || field.type === "multi_reference") {
            const ids = Array.isArray(value) ? value : [String(value)];
            const refs = ids.map((id) =>
              snapshot.records.find(
                (record) => record.tableId === field.referenceTableId && record.id === id,
              ),
            );
            if (refs.some((ref) => !ref)) {
              brokenReference = true;
              break;
            }
            text = refs.map((ref) => ref!.displayText).join("、");
          } else text = Array.isArray(value) ? value.join("、") : String(value);
          if (text) lines.push(`${field.name}：${text}`);
        }
        const text = lines.join("\n");
        if (!text && !brokenReference) {
          coverage.empty++;
          continue;
        }
        coverage.expected++;
        const vector = byTarget.get(JSON.stringify([record.id, group.id]));
        if (brokenReference || (profile && text.length > profile.maxInputChars)) coverage.invalid++;
        else if (!vector) coverage.missing++;
        else if (
          vector.fingerprint !==
            JSON.stringify([group.fieldIds, text, profile!.model, profile!.version]) ||
          vector.model !== profile!.model ||
          vector.version !== profile!.version
        )
          coverage.stale++;
        else if (
          !valid(vector.values) ||
          (profile!.dimensions !== undefined && vector.values.length !== profile!.dimensions)
        )
          coverage.invalid++;
        else {
          coverage.ready++;
          candidates.push({ record, groupKey: group.key, vector });
        }
      }
    }
    if (!candidates.length) return result;
    if (embedding.getProfile()?.version !== profile!.version)
      throw new Error("embedding 连接已变更");
    const vectorResult = await queryVectors.get(query);
    const queryVector = vectorResult.values;
    if (embedding.getProfile()?.version !== profile!.version)
      throw new Error("embedding 连接已变更");
    check();
    if (
      !valid(queryVector) ||
      (profile!.dimensions !== undefined && queryVector.length !== profile!.dimensions)
    )
      throw new Error("查询向量维度或数值异常");
    const queryNorm = norm(queryVector);
    const rows = new Map<string, SemanticScoreRow>();
    for (let i = 0; i < candidates.length; i++) {
      if (i % 100 === 0) await yieldExecution();
      const { record, groupKey, vector } = candidates[i]!;
      if (vector.values.length !== queryVector.length) {
        coverage.ready--;
        coverage.invalid++;
        continue;
      }
      const vectorNorm = norm(vector.values);
      let score = 0;
      for (let j = 0; j < queryVector.length; j++) {
        if (j > 0 && j % 16384 === 0) await yieldExecution();
        score += (queryVector[j]! / queryNorm) * (vector.values[j]! / vectorNorm);
      }
      score = Math.max(-1, Math.min(1, score));
      const old = rows.get(record.id);
      if (!old || score > old.score || (score === old.score && groupKey < old.groupKey))
        rows.set(record.id, { recordId: record.id, score, groupKey });
    }
    return {
      ...result,
      rows: [...rows.values()],
      calls: vectorResult.calls,
      executionHits: vectorResult.executionHits,
      sharedHits: vectorResult.sharedHits,
    };
  }

  return {
    validate: sourceMetadata,
    get(source: SemanticSqlSourceRequest): Promise<SemanticScoreResult> {
      check();
      sourceMetadata(source);
      if (!source.groups.length || new Set(source.groups).size !== source.groups.length)
        throw new Error("语义源分组必须非空且不能重复");
      const normalized = {
        ...source,
        groups: [...source.groups].sort(),
        query: source.query.trim(),
      };
      const key = semanticSourceKey(normalized);
      const existing = scores.get(key);
      if (existing)
        return existing.then((result) => ({
          ...result,
          calls: 0,
          executionHits: 0,
          sharedHits: 0,
        }));
      const request = scoreSource(normalized);
      scores.set(key, request);
      void request.catch(() => {
        if (scores.get(key) === request) scores.delete(key);
      });
      return request;
    },
  };
}
