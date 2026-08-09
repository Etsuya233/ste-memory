import {
  CHAT_MIRROR_FORMAT,
  CHAT_MIRROR_VERSION,
  createChatMirrorFile,
  decodeChatMirrorFile,
} from "../src/memory/chat-mirror/index.ts";
import type { ChatMirrorFile } from "../src/memory/chat-mirror/index.ts";
import type { MemorySpaceBackup } from "../src/memory/export/index.ts";
import type {
  MemoryEvidenceId,
  MemoryFieldId,
  MemoryRecordHistoryId,
  MemoryRecordId,
  MemoryRevisionId,
  MemorySpaceId,
  MemoryTableId,
} from "../src/memory/index.ts";
import { describe, expect, it } from "vitest";

/**
 * 对话文件镜像编解码（ticket 16）：信封与备份单元同构（data = 完整
 * MemorySpaceBackup），语义与云同步文件不同——**未知版本/损坏一律返回 null
 * 由调用方忽略**（镜像只是随文件走的恢复源，绝不抛错打断打开流程）。
 */

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
    history: [
      {
        id: "history-1" as MemoryRecordHistoryId,
        recordId: "record-1" as MemoryRecordId,
        memorySpaceId: "space-1" as MemorySpaceId,
        tableId: "table-1" as MemoryTableId,
        payload: { "field-1": "未知" },
        fieldEvidence: {},
        displayText: "未知",
        source: { type: "manual" },
        previousRevisionId: "revision-0" as MemoryRevisionId,
        previousRevisionSource: "user",
        revisionId: "revision-1" as MemoryRevisionId,
        revisionSource: "user",
        createdAt: "2026-07-28T01:00:00.000Z",
        updatedAt: "2026-07-28T01:30:00.000Z",
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
    ],
  };
}

function sampleMirror(overrides: Partial<ChatMirrorFile> = {}): ChatMirrorFile {
  return {
    ...createChatMirrorFile(sampleUnit(), "space-1", "2026-07-28T02:00:00.000Z", "0.1.0"),
    ...overrides,
  };
}

describe("createChatMirrorFile（组装信封）", () => {
  it("信封与 data 完整保留（含历史/证据）", () => {
    const file = createChatMirrorFile(sampleUnit(), "space-1", "2026-07-28T02:00:00.000Z", "0.1.0");
    expect(file.format).toBe("ste-memory-chat-mirror");
    expect(file.version).toBe(1);
    expect(file.spaceId).toBe("space-1");
    expect(file.updatedAt).toBe("2026-07-28T02:00:00.000Z");
    expect(file.appVersion).toBe("0.1.0");
    expect(file.data).toEqual(sampleUnit());
  });

  it("includeHistory=false：只裁掉 history，其余照旧（设置项「镜像包含修订历史」关闭）", () => {
    const file = createChatMirrorFile(
      sampleUnit(),
      "space-1",
      "2026-07-28T02:00:00.000Z",
      "0.1.0",
      false,
    );
    expect(file.data.history).toEqual([]);
    expect(file.data.records).toEqual(sampleUnit().records);
    expect(file.data.tables).toEqual(sampleUnit().tables);
    expect(file.data.evidence).toEqual(sampleUnit().evidence);
  });
});

describe("decodeChatMirrorFile（忽略语义：无法识别 → null，绝不抛错）", () => {
  it("往返：有效镜像完整还原（含历史/证据）", () => {
    const file = sampleMirror();
    expect(decodeChatMirrorFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });

  it("未知版本 → null（降级安全，调用方原样保留不覆盖）", () => {
    const file = sampleMirror() as unknown as Record<string, unknown>;
    expect(decodeChatMirrorFile({ ...file, version: 2 })).toBeNull();
    expect(decodeChatMirrorFile({ ...file, version: CHAT_MIRROR_VERSION + 1 })).toBeNull();
  });

  it("非本插件 format / 非对象 / 顶层缺字段 → null", () => {
    const file = sampleMirror() as unknown as Record<string, unknown>;
    expect(decodeChatMirrorFile({ ...file, format: "other" })).toBeNull();
    expect(decodeChatMirrorFile("oops")).toBeNull();
    expect(decodeChatMirrorFile(null)).toBeNull();
    expect(decodeChatMirrorFile(42)).toBeNull();
    expect(decodeChatMirrorFile([])).toBeNull();
  });

  it("spaceId 与单元空间不一致 → null（文件自相矛盾时不可信）", () => {
    expect(decodeChatMirrorFile(sampleMirror({ spaceId: "space-other" }))).toBeNull();
  });

  it("结构损坏（data.tables 非数组）→ null", () => {
    const file = sampleMirror() as unknown as Record<string, unknown>;
    const { data, ...rest } = file;
    expect(
      decodeChatMirrorFile({ ...rest, data: { ...(data as object), tables: "x" } }),
    ).toBeNull();
  });

  it("完整性违规（记录指向不存在表格）→ null（复用备份 codec 校验）", () => {
    const unit = sampleUnit();
    const broken = {
      ...unit,
      records: unit.records.map((record) => ({
        ...record,
        tableId: "table-nope" as MemoryTableId,
      })),
    };
    const file = createChatMirrorFile(broken, "space-1", "2026-07-28T02:00:00.000Z", "0.1.0");
    expect(decodeChatMirrorFile(file)).toBeNull();
  });

  it("格式常量导出正确", () => {
    expect(CHAT_MIRROR_FORMAT).toBe("ste-memory-chat-mirror");
    expect(CHAT_MIRROR_VERSION).toBe(1);
  });
});
