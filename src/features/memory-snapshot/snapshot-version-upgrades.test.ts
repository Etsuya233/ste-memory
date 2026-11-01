import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { legacySnapshotFixture } from "./snapshot-test-fixture.ts";
import { upgradeLegacySnapshotToV1 } from "./snapshot-legacy-upgrade.ts";
import {
  migrateMemorySpaceSnapshot,
  upgradeSnapshotV1ToV2,
  upgradeSnapshotV2ToV3,
} from "./snapshot-migration.ts";
import {
  memorySpaceSnapshotV1Schema,
  memorySpaceSnapshotV2Schema,
  memorySpaceSnapshotSchema,
} from "./snapshot-schema.ts";

describe("快照逐版本契约", () => {
  it("旧外壳到v1只转换旧字段，v2补台账，v3添加稳定身份", () => {
    const legacy = legacySnapshotFixture();
    const before = structuredClone(legacy);
    const v1 = upgradeLegacySnapshotToV1(legacy, "legacy-macros");
    expect(v1.schemaVersion).toBe(1);
    expect(v1).not.toHaveProperty("floorLedger");
    expect(v1.space).not.toHaveProperty("stableId");
    expect(v1.records[0]).not.toHaveProperty("stableId");
    expect(v1.history[0]).not.toHaveProperty("stableId");
    expect(v1.space).toMatchObject({ macros: [], initializationSource: null });
    expect(v1.tables[0]).toMatchObject({ position: 0 });
    expect(v1.tables[0]).not.toHaveProperty("kind");
    expect(Value.Check(memorySpaceSnapshotV1Schema, v1)).toBe(true);
    const v2 = upgradeSnapshotV1ToV2(v1);
    expect(v2).toEqual({ ...v1, schemaVersion: 2, floorLedger: [] });
    expect(Value.Check(memorySpaceSnapshotV2Schema, v2)).toBe(true);
    expect(v2.space).not.toHaveProperty("stableId");
    const v3 = upgradeSnapshotV2ToV3(v2);
    expect(Value.Check(memorySpaceSnapshotSchema, v3)).toBe(true);
    expect(v3.space.stableId).toBe("space");
    expect(v3.records[0]!.stableId).toBe("record");
    expect(v3.history[0]!.stableId).toBe(v3.history[0]!.recordId);
    for (const [version, snapshot] of [
      ["legacy-macros", legacy],
      [1, v1],
      [2, v2],
    ] as const) {
      expect(migrateMemorySpaceSnapshot({ version, snapshot })).toEqual(v3);
    }
    expect(legacy).toEqual(before);
    expect(v1).not.toHaveProperty("floorLedger");
  });

  it.each([1, 2])("当前来源声明不能把schemaVersion=%i当作旧版本修补", (schemaVersion) => {
    const v1 = upgradeLegacySnapshotToV1(legacySnapshotFixture(), "legacy-macros");
    expect(() =>
      migrateMemorySpaceSnapshot({ version: 3, snapshot: { ...v1, schemaVersion } }),
    ).toThrow();
  });

  it("历史schema不要求后续版本字段，并保留旧外壳自带台账", () => {
    const floorLedger = [{ floor: 7, status: "error" as const, updatedAt: "now" }];
    const legacy = { ...legacySnapshotFixture(), floorLedger };
    const v1 = upgradeLegacySnapshotToV1(legacy, "legacy-views");
    const v2 = upgradeSnapshotV1ToV2(v1);
    expect(v1.floorLedger).toEqual(floorLedger);
    expect(v2.floorLedger).toEqual(floorLedger);
    expect(
      migrateMemorySpaceSnapshot({ version: "legacy-views", snapshot: legacy }).floorLedger,
    ).toEqual(floorLedger);
    const withoutProgress = { ...v1 };
    Reflect.deleteProperty(withoutProgress, "floorLedger");
    expect(Value.Check(memorySpaceSnapshotV1Schema, withoutProgress)).toBe(true);
    expect(Value.Check(memorySpaceSnapshotV2Schema, { ...withoutProgress, schemaVersion: 2 })).toBe(
      false,
    );
    expect(Value.Check(memorySpaceSnapshotSchema, { ...v2, schemaVersion: 3 })).toBe(false);
    expect(v1.space).not.toHaveProperty("stableId");
    expect(v2.history[0]).not.toHaveProperty("stableId");
  });
});
