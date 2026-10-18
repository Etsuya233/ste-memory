import type {
  BackupIdFactory,
  MemoryBackupRepository,
  MemoryBackupSnapshot,
  MemorySpaceBackup,
  MemorySpaceBackupLedgerEntry,
} from "../../../features/backup/index.ts";
import type {
  MemoryEvidence,
  MemoryEvidenceId,
  MemoryField,
  MemoryFieldEvidence,
  MemoryFieldId,
  MemoryRecord,
  MemoryRecordHistory,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemoryRecordPayload,
  MemorySpaceId,
  MemorySpace,
  MemoryTable,
  MemoryTableId,
} from "../../../features/memory/index.ts";
import { remapMemoryTableDisplayStrategy } from "../../../features/memory/index.ts";
import type { FillTask } from "../../../features/fill-tasks/fill-task.ts";
import type { SteMemoryDatabase, MemoryEvidenceRow } from "../database.ts";
import { normalizeTaskRow } from "../fill-tasks/fill-task-repository.ts";
import { toDomainEvidence, toEvidenceRow } from "../memory/evidence-conversion.ts";

/**
 * Memory MemoryBackupRepository 端口的 Dexie（IndexedDB）实现（ADR 0002 / 0021）。
 *
 * - loadSnapshot：读全部六张表 + 该空间的填表任务与楼层进度台账，把证据行还原为
 *   领域对象（evidence_id / 去掉 memorySpaceId 包装），按空间分组；各数组按 id
 *   排序保证确定性。
 * - restoreSnapshot：整体替换——六张表 + 任务/进度表清空后按空间单元依次写入，
 *   全部包在同一个读写事务里：任一步失败（如主键冲突）整体回滚，绝不产生半导入
 *   状态（导入前校验由 Memory codec 负责，这里只兜底物理约束）。
 * - 任务/进度/对话级宏是可选集合（spec 表格预设 6.3）：单元带这些键 = 替换目标
 *   空间的对应内容；缺省 = 不涉及，保持目标原有值（对话文件镜像即如此）。
 */
export class DexieMemoryBackupRepository implements MemoryBackupRepository {
  readonly #db: SteMemoryDatabase;

  constructor(db: SteMemoryDatabase) {
    this.#db = db;
  }

  async loadSnapshot(): Promise<MemoryBackupSnapshot> {
    const [spaces, tables, fields, records, history, evidenceRows, tasks, ledgerRows] =
      await Promise.all([
        this.#db.memorySpaces.toArray(),
        this.#db.memoryTables.toArray(),
        this.#db.memoryFields.toArray(),
        this.#db.memoryRecords.toArray(),
        this.#db.memoryRecordHistory.toArray(),
        this.#db.memoryEvidence.toArray(),
        this.#db.memoryFillTasks.toArray(),
        this.#db.floorFillLedger.toArray(),
      ]);
    const sorted = {
      spaces: [...spaces].sort((left, right) => left.id.localeCompare(right.id)),
      tables: [...tables].sort((left, right) => left.id.localeCompare(right.id)),
      fields: [...fields].sort((left, right) => left.id.localeCompare(right.id)),
      records: [...records].sort((left, right) => left.id.localeCompare(right.id)),
      history: [...history].sort((left, right) => left.id.localeCompare(right.id)),
      evidence: [...evidenceRows].sort((left, right) => left.id.localeCompare(right.id)),
      tasks: [...tasks]
        .map(normalizeTaskRow)
        .sort((left, right) => left.runId.localeCompare(right.runId)),
      ledger: [...ledgerRows].sort(
        (left, right) => left.floor - right.floor || left.id.localeCompare(right.id),
      ),
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
        fillTasks: sorted.tasks.filter((task) => task.memorySpaceId === space.id),
        floorLedger: sorted.ledger
          .filter((row) => row.memorySpaceId === space.id)
          .map((row) => ({ floor: row.floor, status: row.status, updatedAt: row.updatedAt })),
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
        this.#db.memoryFillTasks,
        this.#db.floorFillLedger,
      ],
      async () => {
        await Promise.all([
          this.#db.memorySpaces.clear(),
          this.#db.memoryTables.clear(),
          this.#db.memoryFields.clear(),
          this.#db.memoryRecords.clear(),
          this.#db.memoryRecordHistory.clear(),
          this.#db.memoryEvidence.clear(),
          this.#db.memoryFillTasks.clear(),
          this.#db.floorFillLedger.clear(),
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
   * 同事务语义：任一步失败整体回滚。单元带任务/进度时一并替换该空间的对应行，
   * 缺省（镜像不带）保持原有值与既有行为。
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
        this.#db.memoryFillTasks,
        this.#db.floorFillLedger,
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
        if (unit.fillTasks !== undefined || unit.floorLedger !== undefined) {
          await this.#db.memoryFillTasks.where("memorySpaceId").equals(spaceId).delete();
          await this.#db.floorFillLedger.where("memorySpaceId").equals(spaceId).delete();
        }
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
    const [tables, fields, records, history, evidenceRows, tasks, ledgerRows] = await Promise.all([
      this.#db.memoryTables.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.memoryFields.filter((field) => field.memorySpaceId === sourceSpaceId).toArray(),
      this.#db.memoryRecords.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.memoryRecordHistory.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.memoryEvidence.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.memoryFillTasks.where("memorySpaceId").equals(sourceSpaceId).toArray(),
      this.#db.floorFillLedger.where("memorySpaceId").equals(sourceSpaceId).toArray(),
    ]);
    return this.#writeClonedUnit(
      {
        space: sourceSpace,
        tables,
        fields,
        records,
        history,
        evidenceRows,
        fillTasks: tasks.map(normalizeTaskRow),
        floorLedger: ledgerRows.map((row) => ({
          floor: row.floor,
          status: row.status,
          updatedAt: row.updatedAt,
        })),
      },
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
        fillTasks: unit.fillTasks ?? [],
        floorLedger: unit.floorLedger ?? [],
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
      readonly fillTasks: readonly FillTask[];
      readonly floorLedger: readonly MemorySpaceBackupLedgerEntry[];
    },
    createId: BackupIdFactory,
  ): Promise<MemorySpaceId> {
    // 生成新 space ID
    const newSpaceId = createId.space();
    const { tables, fields, records, history, evidenceRows, fillTasks, floorLedger } = source;

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

    const fieldsById = new Map<string, MemoryField>(fields.map((field) => [field.id, field]));

    /**
     * 记录 ID 解析：记录本体命中映射表；**已删记录的归档历史**（历史行对已删记录的
     * 归属，属合法遗留）落空时分配新身份并 memoize——同一条被删记录的历史行共享同一
     * 新 ID，且绝不产出 undefined（undefined 会被 JSON 序列化丢键，导出文件随之
     * 通不过导入结构校验）。历史遗留的坏行（recordId 曾丢过）逐行分配新身份。
     */
    const resolveRecordId = (oldRecordId: string | undefined): MemoryRecordId => {
      if (oldRecordId === undefined) return createId.record();
      const mapped = recordIdMap.get(oldRecordId);
      if (mapped !== undefined) return mapped;
      const allocated = createId.record();
      recordIdMap.set(oldRecordId, allocated);
      return allocated;
    };

    /**
     * payload 重映射：键旧 fieldId → 新 fieldId，字段已删则丢弃该键（保留旧 ID 会让
     * 克隆单元带悬挂字段键，导出通不过导入完整性校验；读路径本就按定义漂移投影掉
     * 这些键）。引用值（记录 ID）同样重映射。
     */
    const remapPayload = (payload: MemoryRecordPayload): MemoryRecordPayload => {
      const next: Record<string, unknown> = {};
      for (const [oldFieldId, value] of Object.entries(payload)) {
        const newFieldId = fieldIdMap.get(oldFieldId);
        if (newFieldId === undefined) continue;
        const field = fieldsById.get(oldFieldId);
        const isReference = field?.type === "single_reference" || field?.type === "multi_reference";
        if (isReference && Array.isArray(value)) {
          next[newFieldId] = value.map((item) => resolveRecordId(item as string));
        } else if (isReference && typeof value === "string") {
          next[newFieldId] = resolveRecordId(value);
        } else {
          next[newFieldId] = value;
        }
      }
      return next as MemoryRecordPayload;
    };

    /**
     * 字段证据重映射：键旧 fieldId → 新 fieldId（字段已删则丢弃条目）；条目里的证据
     * 引用 → 新 evidence_id（证据行整体重生成 ID，不映射会留下悬挂引用，导出时报
     * 「引用了不存在的证据」）。
     */
    const remapFieldEvidence = (fieldEvidence: MemoryFieldEvidence): MemoryFieldEvidence => {
      const next: Record<string, readonly MemoryEvidence[]> = {};
      for (const [oldFieldId, entries] of Object.entries(fieldEvidence)) {
        const newFieldId = fieldIdMap.get(oldFieldId);
        if (newFieldId === undefined) continue;
        const remapped: MemoryEvidence[] = [];
        for (const entry of entries) {
          const newEvidenceId = evidenceIdMap.get(entry.evidence_id);
          if (newEvidenceId === undefined) continue; // 防御：引用必须落在单元证据表内
          remapped.push({ ...entry, evidence_id: newEvidenceId });
        }
        next[newFieldId] = remapped;
      }
      return next;
    };

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
        this.#db.memoryFillTasks,
        this.#db.floorFillLedger,
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

        // 写入新记录行（重映射 memorySpaceId, tableId, payload 与字段证据；
        // revisionId 是独立的修订身份，不需要映射）
        if (records.length > 0) {
          await this.#db.memoryRecords.bulkAdd(
            records.map((record) => ({
              ...record,
              id: recordIdMap.get(record.id)!,
              memorySpaceId: newSpaceId,
              tableId: tableIdMap.get(record.tableId)!,
              revisionId: record.revisionId,
              payload: remapPayload(record.payload),
              fieldEvidence: remapFieldEvidence(record.fieldEvidence),
            })),
          );
        }

        // 写入新历史行（重映射 memorySpaceId, tableId, recordId, payload 与字段证据；
        // 已删记录的归档历史由 resolveRecordId 分配新归属）
        if (history.length > 0) {
          await this.#db.memoryRecordHistory.bulkAdd(
            history.map((item) => ({
              ...item,
              id: historyIdMap.get(item.id)!,
              memorySpaceId: newSpaceId,
              tableId: tableIdMap.get(item.tableId)!,
              recordId: resolveRecordId(item.recordId),
              revisionId: item.revisionId,
              payload: remapPayload(item.payload),
              fieldEvidence: remapFieldEvidence(item.fieldEvidence),
            })),
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

        // 写入克隆的任务与楼层进度：任务换新 runId（runId 是全局主键，直接复用会
        // 与源空间任务行相撞），进度行按新空间重算 id
        if (fillTasks.length > 0) {
          await this.#db.memoryFillTasks.bulkAdd(
            fillTasks.map((task) => ({
              ...task,
              runId: createId.task(),
              memorySpaceId: newSpaceId,
            })),
          );
        }
        if (floorLedger.length > 0) {
          await this.#db.floorFillLedger.bulkAdd(
            floorLedger.map((entry) => ({
              id: `${newSpaceId}:${entry.floor}`,
              memorySpaceId: newSpaceId,
              floor: entry.floor,
              status: entry.status,
              updatedAt: entry.updatedAt,
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
    // 任务/进度为可选集合：带键即写入（调用方已按需删除目标行），缺省不涉及
    if (unit.fillTasks !== undefined && unit.fillTasks.length > 0) {
      await this.#db.memoryFillTasks.bulkAdd([...unit.fillTasks]);
    }
    if (unit.floorLedger !== undefined && unit.floorLedger.length > 0) {
      await this.#db.floorFillLedger.bulkAdd(
        unit.floorLedger.map((entry) => ({
          id: `${unit.space.id}:${entry.floor}`,
          memorySpaceId: unit.space.id,
          floor: entry.floor,
          status: entry.status,
          updatedAt: entry.updatedAt,
        })),
      );
    }
  }
}
