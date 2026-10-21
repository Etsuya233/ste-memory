import { DomainError } from "../memory/index.ts";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  createBackupFile,
  decodeBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "./index.ts";
import type { MemoryBackupData, MemorySpaceBackup } from "./index.ts";
import type {
  MemoryEvidenceId,
  MemoryFieldId,
  MemoryFieldKey,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTableId,
  MemoryTableKey,
} from "../memory/index.ts";
import { describe, expect, it } from "vitest";

/** 一个小而完整的备份数据：一个空间 + 表格定义 + 字段 + 记录（含证据与修订历史）。 */
function sampleSnapshot(): MemoryBackupData {
  const space: MemorySpaceBackup = {
    space: {
      id: "space-1" as MemorySpaceId,
      name: "爱丽丝 - story",
      initializationSource: {
        presetId: "systemDefault",
        presetName: "系统默认",
        appliedAt: "2026-07-28T00:00:00.000Z",
      },
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    tables: [
      {
        id: "table-1" as MemoryTableId,
        memorySpaceId: "space-1" as MemorySpaceId,
        key: "characters" as MemoryTableKey,
        position: 0,
        name: "人物",
        description: "登场角色",
        prompt: "只记录有持续影响的角色",
        enabled: true,
        displayStrategy: { type: "field", fieldId: "field-1" as MemoryFieldId },
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    ],
    fields: [
      {
        id: "field-1" as MemoryFieldId,
        memorySpaceId: "space-1" as MemorySpaceId,
        tableId: "table-1" as MemoryTableId,
        key: "name" as MemoryFieldKey,
        name: "名称",
        type: "short_text",
        required: true,
        prompt: "角色称呼",
        enabled: true,
        position: 0,
        options: [],
        referenceTableId: null,
        maxChars: 60,
        valuePattern: null,
        valuePatternMessage: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
      {
        id: "field-2" as MemoryFieldId,
        memorySpaceId: "space-1" as MemorySpaceId,
        tableId: "table-1" as MemoryTableId,
        key: "tags" as MemoryFieldKey,
        name: "标签",
        type: "multi_select",
        required: false,
        prompt: "角色特质",
        enabled: true,
        position: 1,
        options: ["调查员", "记者"],
        referenceTableId: null,
        maxChars: null,
        valuePattern: null,
        valuePatternMessage: null,
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z",
      },
    ],
    records: [
      {
        id: "record-1" as MemoryRecordId,
        memorySpaceId: "space-1" as MemorySpaceId,
        tableId: "table-1" as MemoryTableId,
        payload: { "field-1": "林夏", "field-2": ["调查员"] },
        fieldEvidence: {
          "field-1": [
            {
              evidence_id: "evidence-1" as MemoryEvidenceId,
              source_type: "message",
              source_id: 42,
              storage_mode: "snapshot",
              content: "「我叫林夏。」",
              extraProps: {},
            },
          ],
        },
        displayText: "林夏",
        source: {
          type: "source",
          sourceTime: "2026-07-28T01:00:00.000Z",
          sourceLocation: "楼层 42",
        },
        revisionId: "revision-2" as MemoryRevisionId,
        revisionSource: "user",
        createdAt: "2026-07-28T01:00:00.000Z",
        updatedAt: "2026-07-28T02:00:00.000Z",
      },
    ],
    history: [
      {
        id: "history-1" as MemoryRecordHistoryId,
        recordId: "record-1" as MemoryRecordId,
        memorySpaceId: "space-1" as MemorySpaceId,
        tableId: "table-1" as MemoryTableId,
        payload: { "field-1": "林夏（旧）", "field-2": [] },
        fieldEvidence: {},
        displayText: "林夏（旧）",
        source: { type: "manual" },
        previousRevisionId: "revision-1" as MemoryRevisionId,
        previousRevisionSource: "agent",
        revisionId: "revision-2" as MemoryRevisionId,
        revisionSource: "user",
        createdAt: "2026-07-28T01:00:00.000Z",
        updatedAt: "2026-07-28T01:00:00.000Z",
        archivedAt: "2026-07-28T02:00:00.000Z",
      },
    ],
    evidence: [
      {
        evidence_id: "evidence-1" as MemoryEvidenceId,
        source_type: "message",
        source_id: 42,
        storage_mode: "snapshot",
        content: "「我叫林夏。」",
        extraProps: {},
      },
      {
        evidence_id: "evidence-2" as MemoryEvidenceId,
        source_type: "message",
        source_id: 7,
        storage_mode: "reference",
        extraProps: {},
      },
    ],
  };
  return { spaces: [space] };
}

function decodeError(value: unknown): DomainError {
  try {
    decodeBackupFile(value);
    throw new Error("decodeBackupFile 应当拒绝该输入");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
}

describe("备份文件编解码", () => {
  it("createBackupFile 组装信封（format/version/exportedAt/appVersion/data）", () => {
    const file = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    expect(file).toEqual({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: "2026-08-05T10:00:00.000Z",
      appVersion: "0.2.0",
      data: sampleSnapshot(),
    });
  });

  it("decodeBackupFile 还原 createBackupFile 的输出（含记录/修订/证据）", () => {
    const file = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    expect(decodeBackupFile(file)).toEqual(file);
  });

  it("serialize → parse 往返后 data 与原始快照一致", () => {
    const file = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    const text = serializeBackupFile(file);
    expect(JSON.parse(text)).toEqual(file);
    expect(parseBackupFile(text).data).toEqual(sampleSnapshot());
  });

  it("初始化来源随单元往返保留（备份与恢复不改写来源快照；AC-17）", () => {
    const file = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    const source = file.data.spaces[0]!.space.initializationSource;
    expect(source).toEqual({
      presetId: "systemDefault",
      presetName: "系统默认",
      appliedAt: "2026-07-28T00:00:00.000Z",
    });
    const reparsed = parseBackupFile(serializeBackupFile(file));
    expect(reparsed.data.spaces[0]!.space.initializationSource).toEqual(source);
  });

  it("旧文件（无初始化来源与表格顺序键）解码时归一化：来源补 null、顺序按数组顺序", () => {
    const file = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    const legacy = JSON.parse(JSON.stringify(file)) as {
      data: { spaces: { space: Record<string, unknown>; tables: Record<string, unknown>[] }[] };
    };
    delete legacy.data.spaces[0]!.space.initializationSource;
    for (const table of legacy.data.spaces[0]!.tables) delete table.position;

    const decoded = decodeBackupFile(legacy);
    expect(decoded.data.spaces[0]!.space.initializationSource).toBeNull();
    expect(decoded.data.spaces[0]!.tables.map((table) => table.position)).toEqual([0]);
    expect(decoded.data.spaces[0]!.tables[0]!.key).toBe("characters");
  });

  it("任务与楼层进度随单元校验：不属于本空间或楼层重复报格式错误", () => {
    const base = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    const foreignTask = JSON.parse(JSON.stringify(base)) as {
      data: { spaces: { fillTasks?: unknown[] }[] };
    };
    foreignTask.data.spaces[0]!.fillTasks = [
      {
        runId: "run-1",
        memorySpaceId: "other-space",
        from: 0,
        to: 1,
        blockSize: 20,
        kind: "floor",
        initText: null,
        chatId: null,
        status: "succeeded",
        errorMessage: null,
        createdAt: "",
        updatedAt: "",
      },
    ];
    expect(decodeError(foreignTask).humanMsg).toContain("不属于空间 space-1");

    const duplicateFloors = JSON.parse(JSON.stringify(base)) as {
      data: { spaces: { floorLedger?: unknown[] }[] };
    };
    duplicateFloors.data.spaces[0]!.floorLedger = [
      { floor: 0, status: "processed", updatedAt: "" },
      { floor: 0, status: "error", updatedAt: "" },
    ];
    expect(decodeError(duplicateFloors).humanMsg).toContain("楼层进度条目重复：0");
  });

  it("serialize 输出人类可读的格式化 JSON", () => {
    const file = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    expect(serializeBackupFile(file).split("\n").length).toBeGreaterThan(2);
  });
});

describe("备份文件信封校验", () => {
  it("非对象输入报格式错误", () => {
    const error = decodeError(null);
    expect(error.type).toBe("memory_backup_format_invalid");
  });

  it("format 不匹配报「不是本插件的备份文件」", () => {
    const error = decodeError({ format: "other-app-backup", version: 1, data: { spaces: [] } });
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("不是本插件的备份文件");
  });

  it("未知版本报「文件版本不支持」并携带版本号", () => {
    const error = decodeError({
      format: BACKUP_FORMAT,
      version: 2,
      exportedAt: "2026-08-05T10:00:00.000Z",
      appVersion: "x",
      data: { spaces: [] },
    });
    expect(error.type).toBe("memory_backup_version_unsupported");
    expect(error.param).toEqual({ version: 2 });
    expect(error.humanMsg).toContain("文件版本不支持");
  });

  it("缺少 version 字段时报错信息不出现 undefined", () => {
    const error = decodeError({ format: BACKUP_FORMAT, data: { spaces: [] } });
    expect(error.type).toBe("memory_backup_version_unsupported");
    expect(error.humanMsg).not.toContain("undefined");
    expect(error.humanMsg).toContain("文件版本不支持");
  });

  it("缺少 data 等结构缺失报格式错误", () => {
    const error = decodeError({ format: BACKUP_FORMAT, version: 1 });
    expect(error.type).toBe("memory_backup_format_invalid");
  });

  it("字段类型错误（如 payload 值类型不符）报格式错误并给出路径", () => {
    const bad = createBackupFile(sampleSnapshot(), "0.2.0", "2026-08-05T10:00:00.000Z");
    // 篡改：payload 塞进一个对象（领域值只允许标量/字符串数组）
    (bad.data.spaces[0]!.records[0]!.payload as Record<string, unknown>)["field-1"] = { x: 1 };
    const error = decodeError(bad);
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("data.spaces[0].records[0].payload");
  });

  it("JSON 解析失败报 invalid_json 并携带原因", () => {
    try {
      parseBackupFile("{ 这不是 JSON");
      throw new Error("parseBackupFile 应当拒绝非法 JSON");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ type: "memory_backup_invalid_json" });
    }
  });
});

describe("备份数据完整性校验", () => {
  it("跨空间重复的表格 id 报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const second: MemorySpaceBackup = {
      space: { ...unit.space, id: "space-2" as MemorySpaceId },
      tables: [
        {
          ...unit.tables[0]!,
          id: "table-1" as MemoryTableId,
          memorySpaceId: "space-2" as MemorySpaceId,
        },
      ],
      fields: [],
      records: [],
      history: [],
      evidence: [],
    };
    const snapshot: MemoryBackupData = { spaces: [unit, second] };
    const error = decodeError(createBackupFile(snapshot, "0.2.0", "2026-08-05T10:00:00.000Z"));
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("table-1");
  });

  it("表格 memorySpaceId 与所在单元不一致报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const mutated: MemorySpaceBackup = {
      ...unit,
      tables: unit.tables.map((table) => ({
        ...table,
        memorySpaceId: "space-9" as MemorySpaceId,
      })),
    };
    const error = decodeError(
      createBackupFile({ spaces: [mutated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("space-9");
  });

  it("字段指向单元内不存在的表格报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const mutated: MemorySpaceBackup = {
      ...unit,
      fields: unit.fields.map((field) => ({ ...field, tableId: "table-9" as MemoryTableId })),
    };
    const error = decodeError(
      createBackupFile({ spaces: [mutated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("table-9");
  });

  it("引用字段的目标表不在单元内报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const mutated: MemorySpaceBackup = {
      ...unit,
      fields: unit.fields.map((field) => ({
        ...field,
        referenceTableId: "table-9" as MemoryTableId,
      })),
    };
    const error = decodeError(
      createBackupFile({ spaces: [mutated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("table-9");
  });

  it("记录指向单元内不存在的表格报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const mutated: MemorySpaceBackup = {
      ...unit,
      records: unit.records.map((record) => ({
        ...record,
        tableId: "table-9" as MemoryTableId,
      })),
    };
    const error = decodeError(
      createBackupFile({ spaces: [mutated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("table-9");
  });

  it("证据 id 重复报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const duplicated: MemorySpaceBackup = {
      ...unit,
      evidence: [unit.evidence[0]!, unit.evidence[0]!],
    };
    const error = decodeError(
      createBackupFile({ spaces: [duplicated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("evidence-1");
  });

  it("记录字段值引用不存在的字段报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const mutated: MemorySpaceBackup = {
      ...unit,
      records: unit.records.map((record) => ({
        ...record,
        payload: { "field-9": "林夏" },
      })),
    };
    const error = decodeError(
      createBackupFile({ spaces: [mutated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("field-9");
  });

  it("记录字段证据引用不存在的字段报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const mutated: MemorySpaceBackup = {
      ...unit,
      records: unit.records.map((record) => ({
        ...record,
        fieldEvidence: { "field-9": record.fieldEvidence["field-1"] ?? [] },
      })),
    };
    const error = decodeError(
      createBackupFile({ spaces: [mutated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("field-9");
  });

  it("记录字段证据引用单元内不存在的证据报格式错误", () => {
    const unit = sampleSnapshot().spaces[0]!;
    const mutated: MemorySpaceBackup = {
      ...unit,
      evidence: unit.evidence.filter((entry) => entry.evidence_id !== "evidence-1"),
    };
    const error = decodeError(
      createBackupFile({ spaces: [mutated] }, "0.2.0", "2026-08-05T10:00:00.000Z"),
    );
    expect(error.type).toBe("memory_backup_format_invalid");
    expect(error.humanMsg).toContain("evidence-1");
  });
});

it("空间通用填写规则随备份往返，缺省规则的旧文件仍可读取", () => {
  const original = sampleSnapshot();
  const withPrompt = {
    spaces: original.spaces.map((unit) => ({
      ...unit,
      space: {
        ...unit.space,
        prompt: "统一填写规则",
        summaryRules: [
          {
            sourceTableKey: "notes",
            targetTableKey: "summaries",
            referenceFieldKey: "group",
            groupSize: 15,
            retainCount: 5,
          },
        ],
      },
    })),
  };
  const restored = parseBackupFile(
    serializeBackupFile(createBackupFile(withPrompt, "0.1.4", "2026-10-20T00:00:00.000Z")),
  );
  expect(restored.data.spaces[0]!.space.prompt).toBe("统一填写规则");
  expect(restored.data.spaces[0]!.space.summaryRules).toEqual(
    withPrompt.spaces[0]!.space.summaryRules,
  );
  expect(
    decodeBackupFile(createBackupFile(original, "0.1.4", "2026-10-20T00:00:00.000Z")).data
      .spaces[0]!.space.prompt,
  ).toBeUndefined();
});
