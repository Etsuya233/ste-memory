import { describe, expect, it } from "vitest";
import type { MemoryField, MemoryFieldId } from "../memory/index.ts";
import { effectiveVectorIndexGroups } from "../memory/index.ts";
import { capturePresetVectorIndex, importPresetVectorIndexGroups } from "./preset-vector-index.ts";

const fields = [
  { id: "a" as MemoryFieldId, key: "name", position: 1, enabled: true },
  { id: "b" as MemoryFieldId, key: "status", position: 0, enabled: true },
  { id: "c" as MemoryFieldId, key: "hidden", position: 2, enabled: false },
] as MemoryField[];

describe("向量配置在空间和预设之间转换", () => {
  it("自动配置随启用字段与定义顺序变化，另存时固化当前快照", () => {
    const config = {
      enabled: true,
      source: "automatic" as const,
      updateMode: "manual" as const,
      groups: [],
    };
    expect(effectiveVectorIndexGroups(config, fields)[0]?.fieldIds).toEqual(["b", "a"]);
    expect(capturePresetVectorIndex(config, fields)?.groups).toEqual([
      { key: "automatic", name: "全部启用字段", fieldKeys: ["status", "name"] },
    ]);
    expect(
      effectiveVectorIndexGroups(
        config,
        fields.map((field) => (field.id === "b" ? { ...field, enabled: false } : field)),
      )[0]?.fieldIds,
    ).toEqual(["a"]);
  });

  it("按字段 Key 精确导入跨组复用，并在缺失或停用时整体拒绝", () => {
    const presetTable = {
      vectorIndex: {
        enabled: true,
        updateMode: "manual" as const,
        groups: [
          { key: "背景", name: "背景", fieldKeys: ["name", "status"] },
          { key: "近况", name: "近况", fieldKeys: ["name"] },
        ],
      },
    };
    let next = 0;
    expect(importPresetVectorIndexGroups(presetTable, fields, () => `g${++next}`)).toEqual([
      { key: "背景", id: "g1", name: "背景", fieldIds: ["a", "b"] },
      { key: "近况", id: "g2", name: "近况", fieldIds: ["a"] },
    ]);
    expect(() =>
      importPresetVectorIndexGroups(
        presetTable,
        fields.map((field) => (field.id === "b" ? { ...field, enabled: false } : field)),
        () => "x",
      ),
    ).toThrow("已停用");
  });
});
