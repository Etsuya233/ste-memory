import { describe, expect, it } from "vitest";
import type { BackupIdFactory } from "../backup/backup-port.ts";
import type {
  MemoryFieldId,
  MemoryEvidenceId,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemorySpaceId,
  MemoryTableId,
} from "../memory/index.ts";
import { cloneMemorySnapshot } from "./snapshot-clone.ts";
import { migrateMemorySpaceSnapshot } from "./snapshot-migration.ts";
import { legacySnapshotFixture } from "./snapshot-test-fixture.ts";
import type { MemorySpaceBackup } from "./snapshot.ts";

function ids(): BackupIdFactory {
  let sequence = 0;
  return {
    space: () => `copy-space-${++sequence}` as MemorySpaceId,
    table: () => `copy-table-${++sequence}` as MemoryTableId,
    field: () => `copy-field-${++sequence}` as MemoryFieldId,
    record: () => `copy-record-${++sequence}` as MemoryRecordId,
    history: () => `copy-history-${++sequence}` as MemoryRecordHistoryId,
    evidence: () => `copy-evidence-${++sequence}` as MemoryEvidenceId,
    group: () => `copy-group-${++sequence}`,
    macro: () => `copy-macro-${++sequence}`,
  };
}

function fixture(): MemorySpaceBackup {
  const unit = migrateMemorySpaceSnapshot({
    version: "legacy-macros",
    snapshot: legacySnapshotFixture(),
  });
  const field = unit.fields[0]!;
  const evidence = {
    evidence_id: "evidence" as MemoryEvidenceId,
    source_type: "message",
    source_id: 1,
    storage_mode: "reference" as const,
    extraProps: {},
  };
  const reference = {
    ...field,
    id: "reference" as MemoryFieldId,
    key: "friend" as typeof field.key,
    type: "single_reference" as const,
    referenceTableId: field.tableId,
    position: 1,
  };
  const multiple = {
    ...reference,
    id: "multiple" as MemoryFieldId,
    key: "friends" as typeof field.key,
    type: "multi_reference" as const,
    position: 2,
  };
  return {
    ...unit,
    space: {
      ...unit.space,
      macros: [
        {
          id: "macro",
          name: "语义",
          enabled: true,
          expression: {
            language: "sql",
            sql: "SELECT * FROM semantic_scores('characters', '[]', 'q')",
            usesSemantic: true,
          },
          output: { format: "text", maxChars: null },
        },
      ],
    },
    tables: [{ ...unit.tables[0]!, displayStrategy: { type: "field", fieldId: field.id } }],
    fields: [field, reference, multiple],
    records: [
      {
        ...unit.records[0]!,
        payload: {
          [field.id]: "人物",
          [reference.id]: unit.records[0]!.id,
          [multiple.id]: [unit.records[0]!.id],
        },
        fieldEvidence: { [field.id]: [evidence] },
      },
    ],
    history: [
      {
        ...unit.history[0]!,
        recordId: "deleted" as MemoryRecordId,
        payload: {
          [field.id]: "已删除人物",
          [reference.id]: "deleted",
          [multiple.id]: [unit.records[0]!.id, "deleted"],
        },
        fieldEvidence: { [field.id]: [evidence] },
      },
      {
        ...unit.history[0]!,
        id: "history-second" as MemoryRecordHistoryId,
        recordId: "deleted" as MemoryRecordId,
        payload: { [reference.id]: "deleted" },
        fieldEvidence: {},
      },
    ],
    evidence: [evidence],
  };
}

describe("空间快照独立副本", () => {
  it("重建空间、表、字段、记录、历史和证据身份，并保持所有引用一致且不修改输入", () => {
    const unit = fixture();
    const before = structuredClone(unit);
    const copy = cloneMemorySnapshot(unit, ids(), "副本", "2026-11-01T00:00:00.000Z");
    const table = copy.tables[0]!;
    const [name, reference, multiple] = copy.fields;
    const record = copy.records[0]!;
    expect(copy.space).toMatchObject({
      name: "副本",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(copy.space.id).not.toBe(unit.space.id);
    expect(table.id).not.toBe(unit.tables[0]!.id);
    expect(table.memorySpaceId).toBe(copy.space.id);
    expect(table.displayStrategy).toEqual({ type: "field", fieldId: name!.id });
    expect(table.vectorIndex!.groups[0]!.fieldIds).toEqual([name!.id]);
    expect(table.vectorIndex!.groups[0]!.id).not.toBe(unit.tables[0]!.vectorIndex!.groups[0]!.id);
    expect(
      copy.fields.every(
        (field) => field.memorySpaceId === copy.space.id && field.tableId === table.id,
      ),
    ).toBe(true);
    expect(reference!.referenceTableId).toBe(table.id);
    expect(multiple!.referenceTableId).toBe(table.id);
    expect(record.id).not.toBe(unit.records[0]!.id);
    expect(record.payload).toEqual({
      [name!.id]: "人物",
      [reference!.id]: record.id,
      [multiple!.id]: [record.id],
    });
    expect(record.fieldEvidence[name!.id]![0]!.evidence_id).toBe(copy.evidence[0]!.evidence_id);
    expect(copy.evidence[0]!.evidence_id).not.toBe(unit.evidence[0]!.evidence_id);
    expect(
      copy.history.every(
        (item) =>
          item.id !== unit.history[0]!.id &&
          item.memorySpaceId === copy.space.id &&
          item.tableId === table.id,
      ),
    ).toBe(true);
    expect(copy.history[0]!.fieldEvidence[name!.id]![0]!.evidence_id).toBe(
      copy.evidence[0]!.evidence_id,
    );
    expect(copy.space.macros[0]).toMatchObject({ name: "语义", enabled: false });
    expect(copy.space.macros[0]!.id).not.toBe("macro");
    expect(unit).toEqual(before);
  });

  it("为已删除记录的多次历史和引用分配同一个新身份，保留历史修订关系", () => {
    const unit = fixture();
    const copy = cloneMemorySnapshot(unit, ids(), "副本", "2026-11-01T00:00:00.000Z");
    const deleted = copy.history[0]!.recordId;
    expect(deleted).not.toBe("deleted");
    expect(deleted).not.toBe(copy.records[0]!.id);
    expect(copy.history[1]!.recordId).toBe(deleted);
    expect(copy.history[0]!.payload[copy.fields[1]!.id]).toBe(deleted);
    expect(copy.history[0]!.payload[copy.fields[2]!.id]).toEqual([copy.records[0]!.id, deleted]);
    expect(copy.history[1]!.payload[copy.fields[1]!.id]).toBe(deleted);
    expect(copy.history[0]!.previousRevisionId).toBe(unit.history[0]!.previousRevisionId);
    expect(copy.history[0]!.revisionId).toBe(unit.history[0]!.revisionId);
  });
});
