import type { MemorySpaceBackup } from "../memory-snapshot/snapshot.ts";
import { migrateMemorySpaceSnapshot } from "../memory-snapshot/snapshot-migration.ts";

export interface HistorySettings {
  readonly enabled: boolean;
  readonly interval: number;
  readonly limit: number;
}

export const DEFAULT_HISTORY_SETTINGS: HistorySettings = { enabled: true, interval: 10, limit: 20 };

export function validateHistorySettings(value: HistorySettings): void {
  if (typeof value.enabled !== "boolean") {
    throw new Error("历史版本自动保存须为布尔值");
  }
  if (
    ![value.interval, value.limit].every((number) => Number.isSafeInteger(number) && number > 0)
  ) {
    throw new Error("历史版本自动保存间隔与保留份数须为正整数");
  }
}

export type HistorySource = "manual" | "automatic" | "before-restore";

export interface FloorRange {
  readonly from: number;
  readonly to: number;
}

export interface HistoryVersion {
  readonly id: string;
  readonly chatKey: string;
  readonly name: string;
  readonly createdAt: string;
  readonly source: HistorySource;
  readonly recordCount: number;
  readonly processedRanges: readonly FloorRange[];
  readonly errorRanges: readonly FloorRange[];
  readonly format: 1;
  readonly compression: "gzip";
  readonly originalBytes: number;
  readonly compressedBytes: number;
}

export interface HistoryProgress {
  readonly chatKey: string;
  readonly spaceId: string;
  readonly established: boolean;
  readonly floors: readonly number[];
}

export interface PreparedHistoryRestore {
  readonly chatKey: string;
  readonly version: HistoryVersion;
  readonly current: MemorySpaceBackup;
  readonly generation: string;
}

export function summarizeFloors(floors: readonly number[]): FloorRange[] {
  const ranges: { from: number; to: number }[] = [];
  for (const floor of [...floors].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && floor === last.to + 1) {
      last.to = floor;
    } else {
      ranges.push({ from: floor, to: floor });
    }
  }
  return ranges;
}

export async function encodeHistoryVersion(
  chatKey: string,
  id: string,
  createdAt: string,
  source: HistorySource,
  snapshot: MemorySpaceBackup,
  name?: string,
): Promise<{ version: HistoryVersion; payload: ArrayBuffer }> {
  const bytes = new Blob([JSON.stringify(snapshot)]);
  const payload = await new Response(
    bytes.stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const defaultName = {
    manual: "手动保存",
    automatic: "填表自动保存",
    "before-restore": "恢复前保存",
  };
  return {
    version: {
      id,
      chatKey,
      source,
      createdAt,
      name: name?.trim() || defaultName[source] + " " + new Date(createdAt).toLocaleString(),
      recordCount: snapshot.records.length,
      processedRanges: summarizeFloors(
        snapshot.floorLedger.filter((row) => row.status === "processed").map((row) => row.floor),
      ),
      errorRanges: summarizeFloors(
        snapshot.floorLedger.filter((row) => row.status === "error").map((row) => row.floor),
      ),
      format: 1,
      compression: "gzip",
      originalBytes: bytes.size,
      compressedBytes: payload.byteLength,
    },
    payload,
  };
}

export async function decodeHistoryVersion(
  version: HistoryVersion,
  payload: ArrayBuffer,
): Promise<MemorySpaceBackup> {
  if (version.format !== 1 || version.compression !== "gzip") {
    throw new Error("历史版本存储格式不支持");
  }
  try {
    const raw = await new Response(
      new Blob([payload]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).json();
    return migrateMemorySpaceSnapshot({ version: raw.schemaVersion, snapshot: raw });
  } catch (cause) {
    throw new Error(
      "历史版本载荷损坏或无法读取：" + (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
}
