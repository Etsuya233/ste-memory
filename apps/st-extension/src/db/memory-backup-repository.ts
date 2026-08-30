import type {
  BackupIdFactory,
  MemoryBackupRepository,
  MemoryBackupSnapshot,
  MemorySpaceBackup,
} from "@ste-memory/core/memory/export";
import type {
  MemoryEvidenceId,
  MemoryField,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemorySpaceId,
  MemorySpace,
  MemoryTable,
  MemoryTableId,
} from "@ste-memory/core/memory";
import { remapMemoryTableDisplayStrategy } from "@ste-memory/core/memory";
import type { SteMemoryDatabase, MemoryEvidenceRow } from "./database.ts";
import { toDomainEvidence, toEvidenceRow } from "./evidence-conversion.ts";

/**
 * core MemoryBackupRepository 端口的 Dexie（IndexedDB）实现（ADR 0002 / 0021）。
 *
 * - loadSnapshot：读全部六张表，把证据行还原为领域对象（evidence_id / 去掉
 *   memorySpaceId 包装），按空间分组；各数组按 id 排序保证确定性。
 * - restoreSnapshot：整体替换——六张表清空后按空间单元依次写入，全部包在
 *   同一个读写事务里：任一步失败（如主键冲突）整体回滚，绝不产生半导入状态
 *   （导入前校验由 core codec 负责，这里只兜底物理约束）。
 */
export class DexieMemoryBackupRepository implements MemoryBackupRepository {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async loadSnapshot(): Promise<MemoryBackupSnapshot> {
    const [spaces, tables, fields, records, history, evidenceRows] = await Promise.all([
      this.#db.memorySpaces.toArray(),
      this.#db.memoryTables.toArray(),
      this.#db.memoryFields.toArray(),
      this.#db.memoryRecords.toArray(),
      this.#db.memoryRecordHistory.toArray(),
      this.#db.memoryEvidence.toArray(),
    ]);
    const sorted = {
      spaces: [...spaces].sort((left, right) => left.id.localeCompare(right.id)),
      tables: [...tables].sort((left, right) => left.id.localeCompare(right.id)),
      fields: [...fields].sort((left, right) => left.id.localeCompare(right.id)),
      records: [...records].sort((left, right) => left.id.localeCompare(right.id)),
      history: [...history].sort((left, right) => left.id.localeCompare(right.id)),
      evidence: [...evidenceRows].sort((left, right) => left.id.localeCompare(right.id)),
    };
    return {
      spaces: sorted.spaces.map((space) => ({
        space,
        tables: sorted.tables.filter((table) => table.memorySpaceId === space.id),
        fields: sorted.fields.filter((field) => field.memorySpaceId === space.id),
        records: sorted.records.filter((record) => record.memorySpaceId === space.id),
        history: sorted.history.filter((item) => item.memorySpaceId === space.id),
        evidence: sorted.evidence
          .filter((row) => row.memorySpaceId === space.id)
          .map(toDomainEvidence),
      })),
    };
  }

  async restoreSnapshot(snapshot: MemoryBackupSnapshot): Promise<void> {
    await this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
      ],
      async () => {
        await Promise.all([
          this.#db.memorySpaces.clear(),
          this.#db.memoryTables.clear(),
          this.#db.memoryFields.clear(),
          this.#db.memoryRecords.clear(),
          this.#db.memoryRecordHistory.clear(),
          this.#db.memoryEvidence.clear(),
        ]);
        for (const unit of snapshot.spaces) {
          await this.#writeUnit(unit);
        }
      },
    );
  }

  /**
   * 按空间恢复单个单元（镜像恢复，ADR 0023）：先删该空间在六张表的全部行，
   * 再写入单元数据——只影响目标空间，其他空间原样保留；与 restoreSnapshot
   * 同事务语义：任一步失败整体回滚。
   */
  async restoreSpace(unit: MemorySpaceBackup): Promise<void> {
    const spaceId = unit.space.id;
    await this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
      ],
      async () => {
        await Promise.all([
          this.#db.memorySpaces.where("id").equals(spaceId).delete(),
          this.#db.memoryTables.where("memorySpaceId").equals(spaceId).delete(),
          // memoryFields 无 memorySpaceId 索引：filter 删除（字段行数少，与
          // DexieSyncChangeSource 同口径，v1 可接受）
          this.#db.memoryFields.filter((field) => field.memorySpaceId === spaceId).delete(),
          this.#db.memoryRecords.where("memorySpaceId").equals(spaceId).delete(),
          this.#db.memoryRecordHistory.where("memorySpaceId").equals(spaceId).delete(),
          this.#db.memoryEvidence.where("memorySpaceId").equals(spaceId).delete(),
        ]);
        await this.#writeUnit(unit);
      },
    );
  }

  /**
   * 克隆单个空间（分支对话分离）：读取源空间的完整单元，为所有实体生成全新 ID，
   * 重映射所有外键引用，在 Dexie 读写事务内原子写入新单元。返回新 spaceId。
   * createId 工厂由调用方注入（与 MemoryRecordService 等服务同模式）。
   */
  async cloneSpace(
    sourceSpaceId: MemorySpaceId,
    createId: BackupIdFactory,
  ): Promise<MemorySpaceId> {
    const sourceSpace = await this.#db.memorySpaces.get(sourceSpaceId);
    if (!sourceSpace) {
      throw new Error(`源空间不存在: ${sourceSpaceId}`);
    }
    // 读取源空间完整单元
    const [tables, fields, records, history, evidenceRows] = await Promise.all([
      this.#db.memoryTables.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.memoryFields.filter((field) => field.memorySpaceId === sourceSpaceId).toArray(),
      this.#db.memoryRecords.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.memoryRecordHistory.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.memoryEvidence.where("memorySpaceId").equals(sourceSpaceId).toArray(),
    ]);
    return this.#writeClonedUnit(
      { space: sourceSpace, tables, fields, records, history, evidenceRows },
      createId,
    );
  }

  /**
   * 从内存中的备份单元克隆空间（单空间导入，issue 26）：数据库里没有源空间，
   * 源就是文件反序列化的单元；为所有实体生成全新 ID，重映射外键引用，原子写入
   * 新单元。返回新 spaceId。createId 工厂由调用方注入。
   */
  async cloneSpaceFromUnit(
    unit: MemorySpaceBackup,
    createId: BackupIdFactory,
  ): Promise<MemorySpaceId> {
    const evidenceRows: MemoryEvidenceRow[] = unit.evidence.map((evidence) =>
      toEvidenceRow(unit.space.id, evidence),
    );
    return this.#writeClonedUnit(
      {
        space: unit.space,
        tables: unit.tables,
        fields: unit.fields,
        records: unit.records,
        history: unit.history,
        evidenceRows,
      },
      createId,
    );
  }

  /** 克隆源空间单元写入为新空间：生成全新 ID + 重映射全部外键，事务内原子写入。 */
  async #writeClonedUnit(
    source: {
      readonly space: MemorySpace;
      readonly tables: readonly MemoryTable[];
      readonly fields: readonly MemoryField[];
      readonly records: readonly MemoryRecord[];
      readonly history: readonly MemoryRecordHistory[];
      readonly evidenceRows: readonly MemoryEvidenceRow[];
    },
    createId: BackupIdFactory,
  ): Promise<MemorySpaceId> {
    // 生成新 space ID
    const newSpaceId = createId.space();
    const { tables, fields, records, history, evidenceRows } = source;

    // 构建旧 ID → 新 ID 映射表
    const tableIdMap = new Map<string, MemoryTableId>();
    for (const table of tables) {
      tableIdMap.set(table.id, createId.table());
    }

    const fieldIdMap = new Map<string, MemoryFieldId>();
    for (const field of fields) {
      fieldIdMap.set(field.id, createId.field());
    }

    const recordIdMap = new Map<string, MemoryRecordId>();
    for (const record of records) {
      recordIdMap.set(record.id, createId.record());
    }

    const historyIdMap = new Map<string, MemoryRecordHistoryId>();
    for (const item of history) {
      historyIdMap.set(item.id, createId.history());
    }

    const evidenceIdMap = new Map<string, MemoryEvidenceId>();
    for (const row of evidenceRows) {
      evidenceIdMap.set(row.id, createId.evidence());
    }

    // 在事务内原子写入
    await this.#db.transaction(
      "rw",
      [
        this.#db.memorySpaces,
        this.#db.memoryTables,
        this.#db.memoryFields,
        this.#db.memoryRecords,
        this.#db.memoryRecordHistory,
        this.#db.memoryEvidence,
      ],
      async () => {
        // 写入新空间行
        await this.#db.memorySpaces.add({
          ...source.space,
          id: newSpaceId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // 写入新表行（重映射 memorySpaceId + 显示策略字段 ID——字段已重生成全新 ID，
        // 策略必须跟着重映射，否则 field 策略显示为空、template 策略预览/提交崩溃）
        if (tables.length > 0) {
          await this.#db.memoryTables.bulkAdd(
            tables.map((table) => ({
              ...table,
              id: tableIdMap.get(table.id)!,
              memorySpaceId: newSpaceId,
              displayStrategy: remapMemoryTableDisplayStrategy(table.displayStrategy, fieldIdMap),
            })),
          );
        }

        // 写入新字段行（重映射 memorySpaceId, tableId, referenceTableId）
        if (fields.length > 0) {
          await this.#db.memoryFields.bulkAdd(
            fields.map((field) => ({
              ...field,
              id: fieldIdMap.get(field.id)!,
              memorySpaceId: newSpaceId,
              tableId: tableIdMap.get(field.tableId)!,
              referenceTableId: field.referenceTableId
                ? tableIdMap.get(field.referenceTableId)!
                : null,
            })),
          );
        }

        // 写入新记录行（重映射 memorySpaceId, tableId, revisionId, payload 字段 key）
        if (records.length > 0) {
          await this.#db.memoryRecords.bulkAdd(
            records.map((record) => {
              // payload 的 key 是旧 fieldId，需要重映射到新 fieldId
              // 引用字段的 value 是记录 ID（或记录 ID 数组），也需要重映射
              const newPayload: Record<string, unknown> = {};
              for (const [oldFieldId, value] of Object.entries(record.payload)) {
                const newFieldId = fieldIdMap.get(oldFieldId as MemoryFieldId) ?? oldFieldId;
                // 查找对应的字段定义，判断是否为引用类型
                const fieldDef = fields.find((f) => f.id === oldFieldId);
                const isReference =
                  fieldDef?.type === "single_reference" || fieldDef?.type === "multi_reference";
                if (isReference && Array.isArray(value)) {
                  // multi_reference: value 是 recordId 数组
                  newPayload[newFieldId] = value.map(
                    (v) => recordIdMap.get(v as MemoryRecordId) ?? v,
                  );
                } else if (isReference && typeof value === "string") {
                  // single_reference: value 是单个 recordId
                  newPayload[newFieldId] = recordIdMap.get(value as MemoryRecordId) ?? value;
                } else {
                  newPayload[newFieldId] = value;
                }
              }
              return {
                ...record,
                id: recordIdMap.get(record.id)!,
                memorySpaceId: newSpaceId,
                tableId: tableIdMap.get(record.tableId)!,
                revisionId: record.revisionId, // revisionId 是独立的，不需要映射
                payload: newPayload as typeof record.payload,
              };
            }),
          );
        }

        // 写入新历史行（重映射 memorySpaceId, tableId, recordId, revisionId, payload 字段 key + 引用值）
        if (history.length > 0) {
          await this.#db.memoryRecordHistory.bulkAdd(
            history.map((item) => {
              // 与 records 同理：payload key 是旧 fieldId，引用值是旧 recordId
              const newPayload: Record<string, unknown> = {};
              for (const [oldFieldId, value] of Object.entries(item.payload)) {
                const newFieldId = fieldIdMap.get(oldFieldId as MemoryFieldId) ?? oldFieldId;
                const fieldDef = fields.find((f) => f.id === oldFieldId);
                const isReference =
                  fieldDef?.type === "single_reference" || fieldDef?.type === "multi_reference";
                if (isReference && Array.isArray(value)) {
                  newPayload[newFieldId] = value.map(
                    (v) => recordIdMap.get(v as MemoryRecordId) ?? v,
                  );
                } else if (isReference && typeof value === "string") {
                  newPayload[newFieldId] = recordIdMap.get(value as MemoryRecordId) ?? value;
                } else {
                  newPayload[newFieldId] = value;
                }
              }
              return {
                ...item,
                id: historyIdMap.get(item.id)!,
                memorySpaceId: newSpaceId,
                tableId: tableIdMap.get(item.tableId)!,
                recordId: recordIdMap.get(item.recordId)!,
                revisionId: item.revisionId,
                payload: newPayload as typeof item.payload,
              };
            }),
          );
        }

        // 写入新证据行（重映射 memorySpaceId, evidence_id）
        if (evidenceRows.length > 0) {
          await this.#db.memoryEvidence.bulkAdd(
            evidenceRows.map((row) => ({
              ...row,
              id: evidenceIdMap.get(row.id)!,
              memorySpaceId: newSpaceId,
            })),
          );
        }
      },
    );

    return newSpaceId;
  }

  /** 写入单个空间单元（restoreSnapshot / restoreSpace 共用；调用方已包事务）。 */
  async #writeUnit(unit: MemorySpaceBackup): Promise<void> {
    await this.#db.memorySpaces.add(unit.space);
    if (unit.tables.length > 0) await this.#db.memoryTables.bulkAdd([...unit.tables]);
    if (unit.fields.length > 0) await this.#db.memoryFields.bulkAdd([...unit.fields]);
    if (unit.records.length > 0) await this.#db.memoryRecords.bulkAdd([...unit.records]);
    if (unit.history.length > 0) {
      await this.#db.memoryRecordHistory.bulkAdd([...unit.history]);
    }
    if (unit.evidence.length > 0) {
      await this.#db.memoryEvidence.bulkAdd(
        unit.evidence.map((evidence) => toEvidenceRow(unit.space.id, evidence)),
      );
    }
  }
}
