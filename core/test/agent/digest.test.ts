import { describe, expect, it } from "vitest";
import {
  buildMemorySpaceTableDigest,
  findFieldInDigest,
  findTableInDigest,
} from "../../src/agent/index.ts";
import { createTestMemorySpace } from "./memory-space-fixture.ts";
import { SPACE_ID } from "./memory-space-data.ts";
describe("MemorySpaceTableDigest", () => {
  it("只收录启用表与启用字段，引用目标解析为表 key", async () => {
    const { reader } = createTestMemorySpace();
    const digest = await buildMemorySpaceTableDigest(reader, SPACE_ID);

    expect(digest.memorySpaceId).toBe(SPACE_ID);
    expect(digest.tables.map((table) => table.key)).toEqual(["characters", "locations"]);
    expect(digest.tables.some((table) => table.key === "archives")).toBe(false);

    const characters = findTableInDigest(digest, "characters")!;
    expect(characters.fields.map((field) => field.key)).toEqual([
      "name",
      "current_status",
      "location",
      "aliases",
    ]);
    expect(characters.fields.some((field) => field.key === "secret_notes")).toBe(false);
  });

  it("摘要携带字段类型/必填/选项/引用目标，供提示词与校验共用", async () => {
    const { reader } = createTestMemorySpace();
    const digest = await buildMemorySpaceTableDigest(reader, SPACE_ID);

    const characters = findTableInDigest(digest, "characters")!;
    const name = findFieldInDigest(characters, "name")!;
    expect(name).toMatchObject({ type: "short_text", required: true });

    const currentStatus = findFieldInDigest(characters, "current_status")!;
    expect(currentStatus).toMatchObject({
      type: "single_select",
      required: false,
      options: ["正常", "受伤", "死亡"],
    });

    const location = findFieldInDigest(characters, "location")!;
    expect(location.referenceTableKey).toBe("locations");
  });

  it("查找助手对未启用表/字段返回 undefined", async () => {
    const { reader } = createTestMemorySpace();
    const digest = await buildMemorySpaceTableDigest(reader, SPACE_ID);

    expect(findTableInDigest(digest, "archives")).toBeUndefined();
    expect(findTableInDigest(digest, "nope")).toBeUndefined();
    const characters = findTableInDigest(digest, "characters")!;
    expect(findFieldInDigest(characters, "secret_notes")).toBeUndefined();
    expect(findFieldInDigest(characters, "nope")).toBeUndefined();
  });

  it("同一 reader 上构建多次返回独立结果（每次 run 构建一次的语义）", async () => {
    const { reader } = createTestMemorySpace();
    const first = await buildMemorySpaceTableDigest(reader, SPACE_ID);
    const second = await buildMemorySpaceTableDigest(reader, SPACE_ID);
    expect(first).not.toBe(second);
    expect(first.tables.map((table) => table.id)).toEqual(second.tables.map((table) => table.id));
  });
});
