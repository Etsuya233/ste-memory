import type {
  AgentPresetSettings,
  AgentPromptPreset,
} from "../../../features/agent-presets/preset-model.ts";
import { BUILTIN_AGENT_PRESET_ID } from "../../../features/agent-presets/preset-model.ts";
import type { CleaningRule } from "../../../features/cleaning/cleaning-rules.ts";
import type { FillTaskView, FloorLedgerEntry } from "../../../features/fill-tasks/fill-task.ts";
import { validateBlockSize, validateFloorRange } from "../../models/tasks/task-panel-model.ts";

export interface FillSubmitSummary {
  readonly from: number;
  readonly to: number;
  readonly floorCount: number;
  readonly blockSize: number;
  readonly batchCount: number;
  /** 范围内已成功处理的楼层数。 */
  readonly processedCount: number;
  /** 范围内已标记出错的楼层数。 */
  readonly errorCount: number;
  /** 范围内已被排队任务覆盖的楼层数。 */
  readonly plannedCount: number;
}

export type FillSubmitSummaryResult =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ok"; readonly summary: FillSubmitSummary };

/** 提交前汇总楼层、批次和覆盖风险；校验失败沿用任务面板的可读文案。 */
export function buildFillSubmitSummary(input: {
  readonly fromText: string;
  readonly toText: string;
  readonly blockText: string;
  readonly chatLength: number;
  readonly ledger: readonly FloorLedgerEntry[];
  readonly pending: readonly FillTaskView[];
}): FillSubmitSummaryResult {
  const range = validateFloorRange(input.fromText, input.toText, input.chatLength);
  if (range.kind === "error") return { kind: "error", message: range.message };
  const block = validateBlockSize(input.blockText);
  if (block.kind === "error") return { kind: "error", message: block.message };
  const floorCount = range.to - range.from + 1;
  let processedCount = 0;
  let errorCount = 0;
  for (const entry of input.ledger) {
    if (entry.floor < range.from || entry.floor > range.to) continue;
    if (entry.status === "processed") processedCount += 1;
    if (entry.status === "error") errorCount += 1;
  }
  const planned = new Set<number>();
  for (const task of input.pending) {
    if (task.kind !== "floor") continue;
    if (task.status !== "queued" && task.status !== "running") continue;
    for (
      let floor = Math.max(task.from, range.from);
      floor <= Math.min(task.to, range.to);
      floor += 1
    )
      planned.add(floor);
  }
  return {
    kind: "ok",
    summary: {
      from: range.from,
      to: range.to,
      floorCount,
      blockSize: block.value,
      batchCount: Math.ceil(floorCount / block.value),
      processedCount,
      errorCount,
      plannedCount: planned.size,
    },
  };
}

export function cleaningRuleLabel(
  rules: readonly CleaningRule[],
  selectedRuleId: string | undefined,
): string {
  if (selectedRuleId === undefined) return "不使用清洗规则";
  const rule = rules.find((candidate) => candidate.id === selectedRuleId);
  if (!rule) return "所选规则已不存在（按原文输入）";
  return rule.enabled ? rule.name : `${rule.name}（已停用，按原文输入）`;
}

export function isCleaningRuleDisabled(
  rules: readonly CleaningRule[],
  selectedRuleId: string | undefined,
): boolean {
  if (selectedRuleId === undefined) return false;
  const rule = rules.find((candidate) => candidate.id === selectedRuleId);
  return rule !== undefined && !rule.enabled;
}

export function agentPresetLabel(
  settings: AgentPresetSettings,
  overrideId: string | undefined,
): string {
  const globalPreset = activePreset(settings);
  const globalLabel = globalPreset?.name ?? "系统默认";
  if (overrideId === undefined) return `跟随全局：${globalLabel}`;
  if (overrideId === BUILTIN_AGENT_PRESET_ID) return "系统默认";
  const preset = settings.presets.find((candidate) => candidate.id === overrideId);
  return preset ? `本对话：${preset.name}` : `所选预设已不存在（跟随全局：${globalLabel}）`;
}

export function isAgentPresetOverrideStale(
  settings: AgentPresetSettings,
  overrideId: string | undefined,
): boolean {
  return (
    overrideId !== undefined &&
    overrideId !== BUILTIN_AGENT_PRESET_ID &&
    !settings.presets.some((candidate) => candidate.id === overrideId)
  );
}

function activePreset(settings: AgentPresetSettings): AgentPromptPreset | undefined {
  if (settings.activePresetId === BUILTIN_AGENT_PRESET_ID) return undefined;
  return settings.presets.find((preset) => preset.id === settings.activePresetId);
}
