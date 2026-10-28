import type { FillTaskView, FloorLedgerEntry } from "./fill-task.ts";

export interface AutoFillSettings {
  readonly mode: "off" | "remind" | "auto";
  readonly interval: number;
  readonly includeCurrent: boolean;
  readonly blockSize: number;
  readonly retries: number;
  readonly retryDelaySeconds: number;
  readonly hideAfterSuccess: boolean;
  readonly keepRecentFloors: number;
}

export const DEFAULT_AUTO_FILL_SETTINGS: AutoFillSettings = {
  mode: "off",
  interval: 10,
  includeCurrent: false,
  blockSize: 20,
  retries: 2,
  retryDelaySeconds: 10,
  hideAfterSuccess: false,
  keepRecentFloors: 10,
};

export type PendingFillContinuation = Pick<
  FillTaskView,
  "runId" | "memorySpaceId" | "from" | "to" | "blockSize"
>;

export interface StagedFillTask {
  readonly memorySpaceId: FillTaskView["memorySpaceId"];
  readonly from: number;
  readonly to: number;
  readonly settings: AutoFillSettings;
}

export interface AutoFillChatState {
  /** 旧版本状态，仅用于首次转入统一任务队列。 */
  readonly stagedTasks?: readonly StagedFillTask[];
  readonly inFlightTask?: StagedFillTask;
  readonly lastScheduled?: {
    readonly memorySpaceId: FillTaskView["memorySpaceId"];
    readonly to: number;
  };
  readonly pausedTask?: PendingFillContinuation;
  readonly pendingResumeTask?: PendingFillContinuation;
  readonly acknowledgedInterruptionRunId?: string;
  readonly overrides: Partial<AutoFillSettings>;
  readonly pausedReason: string | null;
}

export interface AutoFillChatStore {
  read(): AutoFillChatState;
  write(state: AutoFillChatState): void;
}

export function validateAutoFillSettings(settings: AutoFillSettings): void {
  if (
    !["off", "remind", "auto"].includes(settings.mode) ||
    typeof settings.includeCurrent !== "boolean" ||
    typeof settings.hideAfterSuccess !== "boolean"
  ) {
    throw new Error("自动填表模式或楼层选项无效");
  }
  for (const key of ["interval", "blockSize", "retries", "retryDelaySeconds"] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < (key === "retries" ? 0 : 1)) {
      throw new Error("自动填表间隔、批大小和等待秒数须为正整数，重试次数须为非负整数");
    }
  }
  if (!Number.isInteger(settings.keepRecentFloors) || settings.keepRecentFloors < 0)
    throw new Error("保留最近楼层数须为非负整数");
}

export function autoFillRange(
  ledger: readonly FloorLedgerEntry[],
  aiFloor: number,
  includeCurrent: boolean,
) {
  const highest = ledger.reduce(
    (max, entry) => (entry.status === "processed" ? Math.max(max, entry.floor) : max),
    -1,
  );
  const from = highest + 1;
  const to = aiFloor - (includeCurrent ? 0 : 1);
  return from <= to ? { from, to } : undefined;
}
