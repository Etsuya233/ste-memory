/** 最小旧格式：保留过往字段的历史与空孤立证据键，覆盖真实旧文件的迁移规则。 */
export function legacySnapshotFixture() {
  const at = "2026-07-28T00:00:00.000Z";
  const record = {
    id: "record",
    memorySpaceId: "space",
    tableId: "table",
    payload: { field: "人物" },
    fieldEvidence: { field: [], removed: [] },
    displayText: "人物",
    source: { type: "manual" as const },
    revisionId: "revision",
    revisionSource: "user" as const,
    createdAt: at,
    updatedAt: at,
  };
  return {
    space: { id: "space", name: "空间", createdAt: at, updatedAt: at },
    tables: [
      {
        id: "table",
        memorySpaceId: "space",
        key: "characters",
        name: "人物",
        kind: "custom",
        description: "",
        prompt: "",
        enabled: true,
        displayStrategy: null,
        createdAt: at,
        updatedAt: at,
        vectorIndex: {
          enabled: false,
          source: "custom" as const,
          updateMode: "manual" as const,
          groups: [{ id: "group", name: "姓名", fieldIds: ["field"] }],
        },
      },
    ],
    fields: [
      {
        id: "field",
        memorySpaceId: "space",
        tableId: "table",
        key: "name",
        name: "姓名",
        type: "short_text" as const,
        required: false,
        prompt: "",
        enabled: true,
        position: 0,
        options: [],
        referenceTableId: null,
        maxChars: null,
        valuePattern: null,
        valuePatternMessage: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
    records: [record],
    history: [
      {
        ...record,
        id: "history",
        recordId: "record",
        payload: { removed: "以前的字段值" },
        previousRevisionId: "previous",
        previousRevisionSource: "user" as const,
        archivedAt: at,
      },
    ],
    evidence: [],
  };
}
