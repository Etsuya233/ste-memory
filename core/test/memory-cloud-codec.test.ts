import type { DomainError } from "../src/memory/index.ts";
import {
  CLOUD_INDEX_KEY,
  cloudSpaceFileKey,
  createCloudIndexFile,
  createCloudSpaceFile,
  decodeCloudIndexFile,
  decodeCloudSpaceFile,
  parseCloudIndexFile,
  parseCloudSpaceFile,
  resolveCloudLww,
} from "../src/memory/cloud/index.ts";
import type { CloudIndexEntry, CloudIndexFile, CloudSpaceFile } from "../src/memory/cloud/index.ts";
import type { MemorySpaceBackup } from "../src/memory/export/index.ts";
import type {
  MemoryEvidenceId,
  MemoryFieldId,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTableId,
} from "../src/memory/index.ts";
import { describe, expect, it } from "vitest";

/** 单个空间单元（含表格/字段/记录/证据/历史的最小完整样本）。 */
function sampleUnit(): MemorySpaceBackup {
  return {
    space: {
      id: "space-1" as MemorySpaceId,
      name: "爱丽丝 - story",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    tables: [
      {
        id: "table-1" as MemoryTableId,
        memorySpaceId: "space-1" as MemorySpaceId,
        key: "characters",
        kind: "system",
        name: "人物",
        description: "",
        prompt: "",
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
        key: "name",
        name: "名称",
        type: "short_text",
        required: true,
        prompt: "",
        enabled: true,
        position: 0,
        options: [],
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
        payload: { "field-1": "林夏" },
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
        source: { type: "manual" },
        revisionId: "revision-1" as MemoryRevisionId,
        revisionSource: "user",
        createdAt: "2026-07-28T01:00:00.000Z",
        updatedAt: "2026-07-28T02:00:00.000Z",
      },
    ],
    history: [],
    evidence: [
      {
        evidence_id: "evidence-1" as MemoryEvidenceId,
        source_type: "message",
        source_id: 42,
        storage_mode: "snapshot",
        content: "「我叫林夏。」",
        extraProps: {},
      },
    ],
  };
}

function sampleSpaceFile(overrides: Partial<CloudSpaceFile> = {}): CloudSpaceFile {
  const base = createCloudSpaceFile(
    sampleUnit(),
    "space-1",
    "2026-07-28T02:00:00.000Z",
    "0.1.0",
    "2026-07-28T03:00:00.000Z",
  );
  return { ...base, ...overrides };
}

function sampleIndexFile(entries: readonly CloudIndexEntry[] = [{ spaceId: "space-1", updatedAt: "2026-07-28T02:00:00.000Z" }]): CloudIndexFile {
  return createCloudIndexFile(entries, "0.1.0", "2026-07-28T03:00:00.000Z");
}

describe("对象键约定", () => {
  it("空间文件键 = spaces/<spaceId>.json；索引键固定 index.json", () => {
    expect(cloudSpaceFileKey("space-1")).toBe("spaces/space-1.json");
    // 键是逻辑键，URL 编码由适配器按路径段负责
    expect(cloudSpaceFileKey("space/1")).toBe("spaces/space/1.json");
    expect(CLOUD_INDEX_KEY).toBe("index.json");
  });
});

describe("空间云文件编解码（信封与备份一致）", () => {
  it("create → parse 往返：信封/spaceId/updatedAt/单元完整保留", () => {
    const file = sampleSpaceFile();
    const decoded = parseCloudSpaceFile(JSON.stringify(file));
    expect(decoded).toEqual(file);
    expect(decoded.format).toBe("ste-memory-backup");
    expect(decoded.version).toBe(1);
    expect(decoded.data.space.id).toBe("space-1");
  });

  it("decode 允许额外键（同版本内 JSON 演进宽容），未知版本明确报错", () => {
    const file = sampleSpaceFile() as unknown as Record<string, unknown>;
    expect(decodeCloudSpaceFile({ ...file, extra: 1 }).spaceId).toBe("space-1");

    const future = { ...file, version: 2 };
    expect(() => decodeCloudSpaceFile(future)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        type: "memory_cloud_version_unsupported",
        humanMsg: expect.stringContaining("文件 v2，当前仅支持 v1"),
      }),
    );
  });

  it("非本插件 format / 非对象 / 缺失版本字段均报格式错误", () => {
    const file = sampleSpaceFile() as unknown as Record<string, unknown>;
    expect(() => decodeCloudSpaceFile({ ...file, format: "other" })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_format_invalid" }),
    );
    expect(() => decodeCloudSpaceFile("oops")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_format_invalid" }),
    );
    const { version, ...noVersion } = file;
    void version;
    expect(() => decodeCloudSpaceFile(noVersion)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_version_unsupported" }),
    );
  });

  it("spaceId 与单元空间不一致 → 格式错误", () => {
    const file = sampleSpaceFile({ spaceId: "space-other" });
    expect(() => decodeCloudSpaceFile(file)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        type: "memory_cloud_format_invalid",
        humanMsg: expect.stringContaining("spaceId space-other 与单元空间 space-1 不一致"),
      }),
    );
  });

  it("结构损坏（data 缺表格数组）→ 结构错误", () => {
    const file = sampleSpaceFile() as unknown as Record<string, unknown>;
    const { data, ...rest } = file;
    expect(() => decodeCloudSpaceFile({ ...rest, data: { ...(data as object), tables: "x" } })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_format_invalid" }),
    );
  });

  it("完整性校验复用备份 codec：记录指向不存在表格 → 格式错误（不碰本地）", () => {
    const unit = sampleUnit();
    const broken = {
      ...unit,
      records: unit.records.map((record) => ({ ...record, tableId: "table-nope" as MemoryTableId })),
    };
    const file = createCloudSpaceFile(broken, "space-1", "2026-07-28T02:00:00.000Z", "0.1.0", "2026-07-28T03:00:00.000Z");
    // 共享完整性校验抛 memory_backup_format_invalid（同一错误族），文案按云同步文件措辞
    expect(() => decodeCloudSpaceFile(file)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        type: "memory_backup_format_invalid",
        humanMsg: "云同步文件无效：记录 record-1 指向不存在的表格 table-nope",
      }),
    );
  });

  it("JSON 层损坏 → 云同步文件不是有效的 JSON", () => {
    expect(() => parseCloudSpaceFile("{not json")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        type: "memory_cloud_format_invalid",
        humanMsg: expect.stringContaining("不是有效的 JSON"),
      }),
    );
  });
});

describe("索引文件编解码", () => {
  it("create → parse 往返；条目按 spaceId 排序", () => {
    const file = createCloudIndexFile(
      [
        { spaceId: "space-b", updatedAt: "2026-07-28T02:00:00.000Z" },
        { spaceId: "space-a", updatedAt: "2026-07-28T01:00:00.000Z" },
      ],
      "0.1.0",
      "2026-07-28T03:00:00.000Z",
    );
    const decoded = parseCloudIndexFile(JSON.stringify(file));
    expect(decoded.spaces.map((entry) => entry.spaceId)).toEqual(["space-a", "space-b"]);
  });

  it("未知版本 / 非本插件 format → 明确报错", () => {
    const file = sampleIndexFile() as unknown as Record<string, unknown>;
    expect(() => decodeCloudIndexFile({ ...file, version: 3 })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        type: "memory_cloud_version_unsupported",
        humanMsg: expect.stringContaining("文件 v3"),
      }),
    );
    expect(() => decodeCloudIndexFile({ ...file, format: "other" })).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_format_invalid" }),
    );
  });

  it("spaceId 重复 / 空 spaceId / 缺 updatedAt → 格式错误", () => {
    const file = sampleIndexFile() as unknown as Record<string, unknown>;
    expect(() =>
      decodeCloudIndexFile({
        ...file,
        spaces: [
          { spaceId: "space-1", updatedAt: "t" },
          { spaceId: "space-1", updatedAt: "t2" },
        ],
      }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_format_invalid" }));
    expect(() =>
      decodeCloudIndexFile({ ...file, spaces: [{ spaceId: "  ", updatedAt: "t" }] }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_format_invalid" }));
    expect(() =>
      decodeCloudIndexFile({ ...file, spaces: [{ spaceId: "space-1" }] }),
    ).toThrowError(expect.objectContaining<Partial<DomainError>>({ type: "memory_cloud_format_invalid" }));
  });
});

describe("LWW 冲突裁决（较新版本胜出）", () => {
  it("云端无条目 → 本地胜（首次上传）", () => {
    expect(resolveCloudLww("2026-07-28T02:00:00.000Z", undefined)).toBe("local");
  });

  it("本地较新 → local；云端较新 → cloud；相同 → equal", () => {
    expect(resolveCloudLww("2026-07-28T03:00:00.000Z", "2026-07-28T02:00:00.000Z")).toBe("local");
    expect(resolveCloudLww("2026-07-28T02:00:00.000Z", "2026-07-28T03:00:00.000Z")).toBe("cloud");
    expect(resolveCloudLww("2026-07-28T02:00:00.000Z", "2026-07-28T02:00:00.000Z")).toBe("equal");
  });

  it("任一时间戳无法解析 → equal（保守不覆盖）", () => {
    expect(resolveCloudLww("oops", "2026-07-28T02:00:00.000Z")).toBe("equal");
    expect(resolveCloudLww("2026-07-28T02:00:00.000Z", "oops")).toBe("equal");
  });
});
