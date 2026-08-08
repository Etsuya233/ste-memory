import { Type } from "typebox";
import { BACKUP_FORMAT, BACKUP_VERSION, memorySpaceBackupSchema } from "../export/backup-file.ts";
import type { MemorySpaceBackup } from "../export/backup-file.ts";

/**
 * 云同步文件格式（ADR 0022）：每记忆空间一个 JSON 文件 + 一个索引文件，
 * 与备份文件共用同一信封（format/version/exportedAt/appVersion，语义一致）。
 *
 * - 空间文件：信封 + spaceId（空间身份）+ updatedAt（LWW 键：该空间最近一次
 *   变更时间，last-write-wins 的胜出依据）+ data（单个记忆空间序列化单元，
 *   与备份文件 data.spaces 元素同构，完整性校验复用 backup-codec）。
 * - 索引文件：信封 + spaces 清单（spaceId + updatedAt）——云端的目录，
 *   空库拉取时按它逐个取空间文件；推送时用它做 LWW 比较（较新版本胜出，
 *   云端更新则本地不覆盖）。
 * - 未知版本（format/version 不匹配）解码时明确报错，绝不覆盖本地。
 *
 * 对象键（R2 bucket 内）：
 * - 空间文件：`spaces/<spaceId>.json`
 * - 索引文件：`index.json`
 */

/** 索引文件在 bucket 中的对象键 */
export const CLOUD_INDEX_KEY = "index.json";

/** 空间云文件的对象键：spaces/<spaceId>.json */
export function cloudSpaceFileKey(spaceId: string): string {
  return `spaces/${spaceId}.json`;
}

/** 空间云文件：信封 + 空间身份 + LWW 键 + 单个空间单元。 */
export interface CloudSpaceFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly spaceId: string;
  /** LWW 键：该空间最近一次变更时间（指纹的 max updatedAt，见插件侧 fingerprint） */
  readonly updatedAt: string;
  readonly data: MemorySpaceBackup;
}

/** 索引条目：云端一个空间的清单项（spaceId + 更新时间）。 */
export interface CloudIndexEntry {
  readonly spaceId: string;
  readonly updatedAt: string;
}

/** 云同步索引文件：信封 + 空间清单（空库拉取的目录，LWW 比较的依据）。 */
export interface CloudIndexFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly spaces: readonly CloudIndexEntry[];
}

// ---------------------------------------------------------------------------
// TypeBox 结构校验 Schema：与备份文件信封同源，形状上区分空间文件与索引文件
// （空间文件有 spaceId + data 单元；索引文件有 spaces 清单）。
// ---------------------------------------------------------------------------

const cloudEnvelopeSchema = Type.Object({
  format: Type.Literal(BACKUP_FORMAT),
  version: Type.Literal(BACKUP_VERSION),
  exportedAt: Type.String(),
  appVersion: Type.String(),
});

export const cloudSpaceFileSchema = Type.Object({
  ...cloudEnvelopeSchema.properties,
  spaceId: Type.String(),
  updatedAt: Type.String(),
  data: memorySpaceBackupSchema,
});

export const cloudIndexFileSchema = Type.Object({
  ...cloudEnvelopeSchema.properties,
  spaces: Type.Array(
    Type.Object({
      spaceId: Type.String(),
      updatedAt: Type.String(),
    }),
  ),
});
