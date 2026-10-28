import { parseSemanticOptions } from "./semantic-options.ts";
import { createExecutionCheckpoint } from "./execution-checkpoint.ts";
import { validateRerankScores, type RerankPort } from "./rerank.ts";
import { DEFAULT_RERANK_SETTINGS, type RerankSettings } from "../settings/rerank-settings.ts";
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
  readonly rerank?: {
    readonly enabled: boolean;
    readonly candidates: number;
    readonly textFields: readonly string[];
    readonly elapsedMs: number;
  };
  readonly calls: number;
  readonly executionHits: number;
  readonly sharedHits: number;
}
export function semanticSourceKey(source: SemanticSqlSourceRequest): string {
  return JSON.stringify([
    source.table,
    source.groups,
    source.query.trim(),
    parseSemanticOptions(source.options) ?? null,
  ]);
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
  rerank?: RerankPort;
  rerankSettings?: RerankSettings;
}) {
  const { snapshot, vectors, embedding, queryVectors, signal, deadline } = input;
  const profile = structuredClone(embedding.getProfile());
  const rerankSettings = structuredClone(input.rerankSettings ?? DEFAULT_RERANK_SETTINGS);
  const reranked = new Map<string, Promise<readonly number[]>>();
  const rerankStats = { requests: 0, cacheHits: 0, candidates: 0 };
  const lanes: Promise<unknown>[] = [Promise.resolve(), Promise.resolve()];
  let scheduled = 0;
  const check = () => {
    signal.throwIfAborted();
    if (performance.now() >= deadline) throw new DOMException("语义评分超时", "TimeoutError");
  };
  const yieldExecution = createExecutionCheckpoint(check);
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
    const options = parseSemanticOptions(source.options);
    const enabled = options?.rerank ?? rerankSettings.enabled;
    if (enabled && (!input.rerank || !rerankSettings.connection))
      throw new Error("启用重排前请配置 rerank 连接");
    const textFields = options?.textFields
      ? options.textFields.map((key) => {
          const field = fields.find((field) => field.key === key && field.enabled);
          if (!field) throw new Error(`重排字段不存在或已停用：${table.key}.${key}`);
          return field;
        })
      : [...new Set(selected.flatMap((group) => group.fieldIds))].map((id) =>
          fields.find((field) => field.id === id)!,
        );
    const query = source.query.trim();
    if (!query) throw new Error("语义查询文本为空或缺少最后用户消息");
    if (query.length > 4000) throw new Error("语义查询文本超过 4000 字符");
    const scope = options?.scopeRecordIds === undefined ? null : new Set(options.scopeRecordIds);
    const records = snapshot.records.filter(
      (record) => record.tableId === table.id && (scope === null || scope.has(record.id)),
    );
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
    const ordered = [...rows.values()].sort(
      (a, b) =>
        b.score - a.score || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0),
    );
    let finalRows: SemanticScoreRow[] = ordered.map((row, index) => ({
      ...row,
      rank: enabled ? null : index + 1,
      rerankScore: null,
      rerankRank: null,
    }));
    let elapsedMs = 0;
    let rerankCount = 0;
    if (enabled && ordered.length) {
      const picked = ordered.slice(0, options?.candidateLimit ?? rerankSettings.candidateLimit);
      const documents = picked.map((row) => {
        const record = records.find((record) => record.id === row.recordId)!;
        const lines: string[] = [];
        for (const field of textFields) {
          const value = record.payload[field.id];
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
            text = ids
              .map((id) => {
                const ref = snapshot.records.find(
                  (item) => item.tableId === field.referenceTableId && item.id === id,
                );
                if (!ref) throw new Error(`重排引用记录不存在：${field.key}/${id}`);
                return ref.displayText;
              })
              .join("、");
          } else text = Array.isArray(value) ? value.join("、") : String(value);
          if (text) lines.push(`${field.name}：${text}`);
        }
        if (!lines.length) throw new Error(`记录 ${record.id} 的重排字段均为空`);
        const text = [`表格：${table.name}`, ...lines].join("\n");
        const limit = rerankSettings.connection!.maxInputChars;
        if (text.length > limit)
          throw new Error(`记录 ${record.id} 的重排文本 ${text.length} 字符超过上限 ${limit}`);
        return text;
      });
      const limit = rerankSettings.connection!.maxInputChars;
      if (query.length > limit) throw new Error(`重排查询超过 ${limit} 字符上限`);
      const requestKey = JSON.stringify([query, documents]);
      if (new TextEncoder().encode(requestKey).byteLength > 2 * 1024 * 1024)
        throw new Error("重排输入超过 2 MiB 上限");
      const started = performance.now();
      let request = reranked.get(requestKey);
      if (request) rerankStats.cacheHits++;
      else {
        if (scheduled >= 16) throw new Error("本批重排请求超过 16 次上限");
        const lane = scheduled++ % lanes.length;
        request = lanes[lane]!.then(async () => {
          check();
          rerankStats.requests++;
          rerankStats.candidates += picked.length;
          const result = await input.rerank!.rerank(query, documents, signal);
          check();
          validateRerankScores(result, documents.length);
          return result;
        });
        lanes[lane] = request.catch(() => undefined);
        reranked.set(requestKey, request);
        void request.catch(() => {
          if (reranked.get(requestKey) === request) reranked.delete(requestKey);
        });
      }
      const values = await request;
      check();
      const ranked = picked
        .map((row, index) => ({ recordId: row.recordId, score: values[index]!, index }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
      const byId = new Map(
        ranked.map((row, index) => [row.recordId, { score: row.score, rank: index + 1 }]),
      );
      finalRows = finalRows.map((row) => {
        const scored = byId.get(row.recordId);
        return scored
          ? { ...row, rerankScore: scored.score, rerankRank: scored.rank, rank: scored.rank }
          : row;
      });
      rerankCount = picked.length;
      elapsedMs = performance.now() - started;
    }
    return {
      ...result,
      rows: finalRows,
      rerank: {
        enabled,
        candidates: rerankCount,
        textFields: textFields.map((field) => field.key),
        elapsedMs,
      },
      calls: vectorResult.calls,
      executionHits: vectorResult.executionHits,
      sharedHits: vectorResult.sharedHits,
    };
  }

  return {
    statistics: () => ({ ...rerankStats }),
    validate(source: Pick<SemanticSqlSourceRequest, "table" | "groups" | "options">) {
      const metadata = sourceMetadata(source);
      const options = parseSemanticOptions(source.options);
      for (const key of options?.textFields ?? [])
        if (!metadata.fields.some((field) => field.key === key && field.enabled))
          throw new Error(`重排字段不存在或已停用：${source.table}.${key}`);
      return metadata;
    },
    get(source: SemanticSqlSourceRequest): Promise<SemanticScoreResult> {
      check();
      sourceMetadata(source);
      if (!source.groups.length || new Set(source.groups).size !== source.groups.length)
        throw new Error("语义源分组必须非空且不能重复");
      const normalized = {
        ...source,
        groups: [...source.groups],
        ...(source.options === undefined ? {} : { options: parseSemanticOptions(source.options) }),
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
