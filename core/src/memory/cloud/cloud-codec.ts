import { Value } from "typebox/value";
import { DomainError } from "../domain/index.ts";
import { BACKUP_FORMAT, BACKUP_VERSION } from "../export/backup-file.ts";
import { createBackupSeenIds, validateSpaceBackupUnit } from "../export/backup-codec.ts";
import {
  cloudIndexFileSchema,
  cloudSpaceFileSchema,
} from "./cloud-file.ts";
import type { CloudIndexEntry, CloudIndexFile, CloudSpaceFile } from "./cloud-file.ts";
import type { MemorySpaceBackup } from "../export/backup-file.ts";

/**
 * 云同步文件编解码（纯函数，ADR 0022）：信封与备份文件一致（format/version
 * 语义相同），未知版本明确报错（memory_cloud_version_unsupported），结构/完整性
 * 校验复用备份 codec（memorySpaceBackupSchema + validateSpaceBackupUnit）。
 */

function formatInvalid(reason: string): never {
  throw new DomainError({
    type: "memory_cloud_format_invalid",
    param: { reason },
    humanMsg: `云同步文件无效：${reason}`,
  });
}

function versionUnsupported(version: unknown): never {
  const versionText = typeof version === "number" ? `文件 v${String(version)}，` : "";
  throw new DomainError({
    type: "memory_cloud_version_unsupported",
    param: { version },
    humanMsg: `云同步文件版本不支持（${versionText}当前仅支持 v${BACKUP_VERSION}）`,
  });
}

/** 信封校验（format/version），与备份文件同语义；不匹配抛 DomainError。 */
function checkEnvelope(value: Record<string, unknown>): void {
  if (value.format !== BACKUP_FORMAT) {
    formatInvalid("不是本插件的云同步文件");
  }
  if (value.version !== BACKUP_VERSION) {
    versionUnsupported(value.version);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 组装备份同信封的空间云文件（unit 即 data，无深拷贝）。 */
export function createCloudSpaceFile(
  unit: MemorySpaceBackup,
  spaceId: string,
  updatedAt: string,
  appVersion: string,
  exportedAt: string,
): CloudSpaceFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    appVersion,
    spaceId,
    updatedAt,
    data: unit,
  };
}

/** 校验并解码空间云文件（信封 + 结构 + 完整性），失败抛 DomainError。 */
export function decodeCloudSpaceFile(value: unknown): CloudSpaceFile {
  if (!isRecord(value)) {
    formatInvalid("文件顶层不是对象");
  }
  checkEnvelope(value);
  if (!Value.Check(cloudSpaceFileSchema, value)) {
    formatInvalid(`结构不符合预期（${firstSchemaError(cloudSpaceFileSchema, value)}）`);
  }
  const file = value as unknown as CloudSpaceFile;
  if (file.spaceId !== file.data.space.id) {
    formatInvalid(`spaceId ${file.spaceId} 与单元空间 ${file.data.space.id} 不一致`);
  }
  validateSpaceBackupUnit(file.data, createBackupSeenIds(), "云同步文件");
  return file;
}

/** JSON 文本 → 空间云文件（解析失败或校验失败均抛 DomainError）。 */
export function parseCloudSpaceFile(text: string): CloudSpaceFile {
  return decodeCloudSpaceFile(parseCloudJson(text, "云同步文件"));
}

/** 组装云同步索引文件（entries 按 spaceId 排序保证确定性）。 */
export function createCloudIndexFile(
  entries: readonly CloudIndexEntry[],
  appVersion: string,
  exportedAt: string,
): CloudIndexFile {
  const spaces = [...entries].sort((left, right) => left.spaceId.localeCompare(right.spaceId));
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    appVersion,
    spaces,
  };
}

/** 校验并解码云同步索引文件（信封 + 结构 + 空间 id 唯一），失败抛 DomainError。 */
export function decodeCloudIndexFile(value: unknown): CloudIndexFile {
  if (!isRecord(value)) {
    formatInvalid("文件顶层不是对象");
  }
  checkEnvelope(value);
  if (!Value.Check(cloudIndexFileSchema, value)) {
    formatInvalid(`结构不符合预期（${firstSchemaError(cloudIndexFileSchema, value)}）`);
  }
  const file = value as unknown as CloudIndexFile;
  const seen = new Set<string>();
  for (const entry of file.spaces) {
    if (entry.spaceId.trim() === "") {
      formatInvalid("索引包含空 spaceId");
    }
    if (seen.has(entry.spaceId)) {
      formatInvalid(`索引 spaceId 重复：${entry.spaceId}`);
    }
    seen.add(entry.spaceId);
  }
  return file;
}

/** JSON 文本 → 云同步索引文件（解析失败或校验失败均抛 DomainError）。 */
export function parseCloudIndexFile(text: string): CloudIndexFile {
  return decodeCloudIndexFile(parseCloudJson(text, "云同步索引"));
}

/** JSON 解析层（与备份 codec 同语义：解析失败抛格式错误，带可读原因） */
function parseCloudJson(text: string, label: "云同步文件" | "云同步索引"): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DomainError({
      type: "memory_cloud_format_invalid",
      param: { reason: error instanceof Error ? error.message : String(error) },
      humanMsg: `${label}不是有效的 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/**
 * last-write-wins 冲突裁决（纯函数）：较新的 updatedAt 胜出。
 * - cloud 无该空间条目（undefined）→ local（首次上传）；
 * - 时间戳无法解析 → equal（不做动作，保守不覆盖）。
 */
export function resolveCloudLww(
  localUpdatedAt: string,
  cloudUpdatedAt: string | undefined,
): "local" | "cloud" | "equal" {
  if (cloudUpdatedAt === undefined) return "local";
  const localTime = Date.parse(localUpdatedAt);
  const cloudTime = Date.parse(cloudUpdatedAt);
  if (Number.isNaN(localTime) || Number.isNaN(cloudTime)) return "equal";
  if (localTime > cloudTime) return "local";
  if (cloudTime > localTime) return "cloud";
  return "equal";
}

/** TypeBox 校验错误的第一条（路径 + 信息，人可读）。 */
function firstSchemaError(schema: object, value: unknown): string {
  for (const error of Value.Errors(schema, value)) {
    return `${error.instancePath || "文件顶层"}: ${error.message}`;
  }
  return "未知";
}
