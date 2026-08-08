import { Value } from "typebox/value";
import { DomainError } from "../domain/index.ts";
import { BACKUP_FORMAT, BACKUP_VERSION, memoryBackupFileSchema } from "./backup-file.ts";
import type { MemoryBackupData, MemoryBackupFile } from "./backup-file.ts";

/**
 * 备份文件编解码（纯函数，ADR 0021）：快照 ↔ 信封对象 ↔ JSON 字符串。
 *
 * - createBackupFile：组装信封（data 即快照本身，无复制）。
 * - decodeBackupFile：导入前校验的唯一入口——先 format/version（未知版本
 *   报「文件版本不支持」），再结构校验（TypeBox，错误带路径），最后
 *   完整性校验（id 唯一、归属一致）。任何失败抛 DomainError，不产生半导入状态。
 * - serializeBackupFile / parseBackupFile：JSON 字符串层，与对象层分离，
 *   两平台共享同一份文本格式。
 */

function formatInvalid(reason: string): never {
  throw new DomainError({
    type: "memory_backup_format_invalid",
    param: { reason },
    humanMsg: `备份文件无效：${reason}`,
  });
}

/** 把 TypeBox 错误路径（/data/spaces/0/...）转成人可读形式（data.spaces[0]...）。 */
function formatErrorPath(path: string | undefined): string {
  if (path === undefined || path === "") return "文件顶层";
  return path
    .replace(/^\//, "")
    .split("/")
    .map((segment, index) =>
      /^\d+$/.test(segment) ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 组装备份文件信封（快照即 data，无深拷贝）。 */
export function createBackupFile(
  snapshot: MemoryBackupData,
  appVersion: string,
  exportedAt: string,
): MemoryBackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    appVersion,
    data: snapshot,
  };
}

/** 校验并解码备份文件（信封 + 结构 + 完整性），失败抛 DomainError。 */
export function decodeBackupFile(value: unknown): MemoryBackupFile {
  if (!isRecord(value)) {
    formatInvalid("文件顶层不是对象");
  }
  if (value.format !== BACKUP_FORMAT) {
    formatInvalid("不是本插件的备份文件");
  }
  if (value.version !== BACKUP_VERSION) {
    const versionText = typeof value.version === "number" ? `文件 v${String(value.version)}，` : "";
    throw new DomainError({
      type: "memory_backup_version_unsupported",
      param: { version: value.version },
      humanMsg: `备份文件版本不支持（${versionText}当前仅支持 v${BACKUP_VERSION}）`,
    });
  }
  if (!Value.Check(memoryBackupFileSchema, value)) {
    const details = [...Value.Errors(memoryBackupFileSchema, value)]
      .slice(0, 5)
      .map((error) => `${formatErrorPath(error.instancePath)}: ${error.message}`)
      .join("；");
    formatInvalid(details);
  }
  validateBackupData((value as unknown as MemoryBackupFile).data);
  return value as unknown as MemoryBackupFile;
}

/**
 * 完整性校验：结构正确但语义损坏的文件在恢复时会撞数据库约束（报错信息晦涩）
 * 或写入悬挂引用。这里在触碰数据库之前拦截：
 * - 各类 id 全局唯一（空间/表格/字段/记录/历史/证据各自一张物理表）；
 * - 实体归属一致：表格/字段/记录/历史/证据必须属于所在单元的空间；
 * - 字段、记录、历史必须指向单元内存在的表格；引用字段的目标表必须在单元内。
 */
export function validateBackupData(data: MemoryBackupData): void {
  const seen = {
    space: new Set<string>(),
    table: new Set<string>(),
    field: new Set<string>(),
    record: new Set<string>(),
    history: new Set<string>(),
    evidence: new Set<string>(),
  };
  for (const unit of data.spaces) {
    const spaceId = unit.space.id;
    if (seen.space.has(spaceId)) formatInvalid(`记忆空间 id 重复：${spaceId}`);
    seen.space.add(spaceId);

    const tableIds = new Set<string>();
    for (const table of unit.tables) {
      if (table.memorySpaceId !== spaceId) {
        formatInvalid(`表格 ${table.id} 不属于空间 ${spaceId}（实际 ${table.memorySpaceId}）`);
      }
      if (seen.table.has(table.id)) formatInvalid(`表格 id 重复：${table.id}`);
      seen.table.add(table.id);
      tableIds.add(table.id);
    }

    const fieldsByTable = new Map<string, Set<string>>();
    for (const field of unit.fields) {
      if (field.memorySpaceId !== spaceId) {
        formatInvalid(`字段 ${field.id} 不属于空间 ${spaceId}（实际 ${field.memorySpaceId}）`);
      }
      if (!tableIds.has(field.tableId)) {
        formatInvalid(`字段 ${field.id} 指向不存在的表格 ${field.tableId}`);
      }
      if (field.referenceTableId !== null && !tableIds.has(field.referenceTableId)) {
        formatInvalid(`字段 ${field.id} 的引用目标表 ${field.referenceTableId} 不在单元内`);
      }
      if (seen.field.has(field.id)) formatInvalid(`字段 id 重复：${field.id}`);
      seen.field.add(field.id);
      let fieldIds = fieldsByTable.get(field.tableId);
      if (!fieldIds) {
        fieldIds = new Set<string>();
        fieldsByTable.set(field.tableId, fieldIds);
      }
      fieldIds.add(field.id);
    }

    for (const record of unit.records) {
      if (record.memorySpaceId !== spaceId) {
        formatInvalid(`记录 ${record.id} 不属于空间 ${spaceId}（实际 ${record.memorySpaceId}）`);
      }
      if (!tableIds.has(record.tableId)) {
        formatInvalid(`记录 ${record.id} 指向不存在的表格 ${record.tableId}`);
      }
      if (seen.record.has(record.id)) formatInvalid(`记录 id 重复：${record.id}`);
      seen.record.add(record.id);
      // 记录载荷与字段证据的键必须是其表格的字段；字段证据引用的证据必须在单元内
      const tableFieldIds = fieldsByTable.get(record.tableId) ?? new Set<string>();
      const unknownPayloadKey = Object.keys(record.payload).find(
        (fieldId) => !tableFieldIds.has(fieldId),
      );
      if (unknownPayloadKey !== undefined) {
        formatInvalid(`记录 ${record.id} 的字段值引用了不存在的字段 ${unknownPayloadKey}`);
      }
      const unknownEvidenceKey = Object.keys(record.fieldEvidence).find(
        (fieldId) => !tableFieldIds.has(fieldId),
      );
      if (unknownEvidenceKey !== undefined) {
        formatInvalid(`记录 ${record.id} 的字段证据引用了不存在的字段 ${unknownEvidenceKey}`);
      }
    }

    for (const history of unit.history) {
      if (history.memorySpaceId !== spaceId) {
        formatInvalid(
          `历史记录 ${history.id} 不属于空间 ${spaceId}（实际 ${history.memorySpaceId}）`,
        );
      }
      if (!tableIds.has(history.tableId)) {
        formatInvalid(`历史记录 ${history.id} 指向不存在的表格 ${history.tableId}`);
      }
      if (seen.history.has(history.id)) formatInvalid(`历史记录 id 重复：${history.id}`);
      seen.history.add(history.id);
    }

    for (const evidence of unit.evidence) {
      if (seen.evidence.has(evidence.evidence_id)) {
        formatInvalid(`证据 id 重复：${evidence.evidence_id}`);
      }
      seen.evidence.add(evidence.evidence_id);
    }

    // 记录字段证据引用的证据条目必须存在于本单元（否则恢复出悬挂引用）
    for (const record of unit.records) {
      for (const evidenceList of Object.values(record.fieldEvidence)) {
        const missing = evidenceList.find((entry) => !seen.evidence.has(entry.evidence_id));
        if (missing) {
          formatInvalid(`记录 ${record.id} 引用了不存在的证据 ${missing.evidence_id}`);
        }
      }
    }
  }
}

/** 备份文件 → 人类可读 JSON 文本（格式化缩进，便于检查与手工修复）。 */
export function serializeBackupFile(file: MemoryBackupFile): string {
  return JSON.stringify(file, null, 2);
}

/** JSON 文本 → 备份文件（解析失败或校验失败均抛 DomainError）。 */
export function parseBackupFile(text: string): MemoryBackupFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new DomainError({
      type: "memory_backup_invalid_json",
      param: { reason: error instanceof Error ? error.message : String(error) },
      humanMsg: `备份文件不是有效的 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
  return decodeBackupFile(value);
}
