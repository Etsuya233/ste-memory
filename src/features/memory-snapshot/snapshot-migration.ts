import {
  legacyMemorySpaceSnapshotSchema,
  memorySpaceSnapshotV1Schema,
  memorySpaceSnapshotV2Schema,
  type LegacySnapshot,
  type SnapshotV1,
  type SnapshotV2,
  type SnapshotV3,
} from "./snapshot-schema.ts";
import { MEMORY_SNAPSHOT_SCHEMA_VERSION, type MemorySpaceBackup } from "./snapshot.ts";
import { snapshotInvalid } from "./snapshot-errors.ts";
import { assertSnapshotStructure, validateCurrentSnapshot } from "./snapshot-validation.ts";
import { upgradeLegacySnapshotToV1 } from "./snapshot-legacy-upgrade.ts";

/** 来源外壳负责辨认历史版本，迁移入口只接收明确版本，不根据缺字段猜测。 */
export type MemorySnapshotVersion =
  "legacy-views" | "legacy-macros" | 1 | 2 | typeof MEMORY_SNAPSHOT_SCHEMA_VERSION;

/** 纯迁移按版本顺序执行；当前格式只校验，不补字段，也不改变输入。 */
export function migrateMemorySpaceSnapshot(input: {
  readonly version: unknown;
  readonly snapshot: unknown;
}): MemorySpaceBackup {
  let snapshot: SnapshotV1 | SnapshotV2 | SnapshotV3;
  // 只校验来源一次；后续各步按固定输入输出契约构造，最后统一校验当前结构。
  switch (input.version) {
    case "legacy-views":
    case "legacy-macros": {
      assertSnapshotStructure(legacyMemorySpaceSnapshotSchema, input.snapshot);
      const legacy = input.snapshot as LegacySnapshot;
      // 旧外壳没有领域版本标记，拒绝伪装成旧文件的新版本。
      if ("schemaVersion" in legacy) {
        snapshotInvalid("旧格式快照不应含 schemaVersion");
      }
      snapshot = upgradeLegacySnapshotToV1(legacy, input.version);
      break;
    }
    case 1:
      assertSnapshotStructure(memorySpaceSnapshotV1Schema, input.snapshot);
      snapshot = input.snapshot as SnapshotV1;
      break;
    case 2:
      assertSnapshotStructure(memorySpaceSnapshotV2Schema, input.snapshot);
      snapshot = input.snapshot as SnapshotV2;
      break;
    case MEMORY_SNAPSHOT_SCHEMA_VERSION:
      return validateCurrentSnapshot(input.snapshot);
    default:
      snapshotInvalid(`快照版本不支持：${String(input.version)}`);
  }
  if (snapshot.schemaVersion === 1) {
    snapshot = upgradeSnapshotV1ToV2(snapshot);
  }
  if (snapshot.schemaVersion === 2) {
    snapshot = upgradeSnapshotV2ToV3(snapshot);
  }
  return validateCurrentSnapshot(snapshot);
}

/** v1→v2：floorLedger 从可选变为必填；仅采用文件自身进度，缺失保持未知。 */
export function upgradeSnapshotV1ToV2(snapshot: SnapshotV1): SnapshotV2 {
  return { ...snapshot, schemaVersion: 2, floorLedger: snapshot.floorLedger ?? [] };
}

/** v2→v3：新增 stableId；使用原始本地 ID，同一记录的历史共享原记录身份。 */
export function upgradeSnapshotV2ToV3(snapshot: SnapshotV2): SnapshotV3 {
  return {
    ...snapshot,
    schemaVersion: 3,
    space: { ...snapshot.space, stableId: snapshot.space.id },
    records: snapshot.records.map((record) => ({ ...record, stableId: record.id })),
    history: snapshot.history.map((history) => ({ ...history, stableId: history.recordId })),
  };
}
