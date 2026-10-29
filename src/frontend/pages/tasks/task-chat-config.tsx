import { Settings2 } from "lucide-react";
import type { AgentPresetSettings } from "../../../features/agent-presets/preset-model.ts";
import { BUILTIN_AGENT_PRESET_ID } from "../../../features/agent-presets/preset-model.ts";
import type { CleaningRule } from "../../../features/cleaning/cleaning-rules.ts";
import { Button } from "../../../ui/primitives/button.tsx";
import { Field, FieldDescription, FieldLabel } from "../../../ui/primitives/field.tsx";
import { NativeSelect } from "../../../ui/primitives/native-select.tsx";
import { isAgentPresetOverrideStale } from "./task-submit-summary.ts";

export function TaskChatConfig({
  rules,
  presetSettings,
  cleaningSelection,
  presetOverride,
  autoFillSummary,
  disabled,
  notice,
  error,
  onCleaningChange,
  onPresetChange,
  onOpenAutoFill,
}: {
  rules: readonly CleaningRule[];
  presetSettings: AgentPresetSettings;
  cleaningSelection: string | undefined;
  presetOverride: string | undefined;
  autoFillSummary: string;
  disabled: boolean;
  notice: string | null;
  error: string | null;
  onCleaningChange: (ruleId: string | undefined) => void;
  onPresetChange: (presetId: string | undefined) => void;
  onOpenAutoFill: () => void;
}) {
  const cleaningMissing =
    cleaningSelection !== undefined && !rules.some((rule) => rule.id === cleaningSelection);
  const presetStale = isAgentPresetOverrideStale(presetSettings, presetOverride);
  const globalPreset =
    presetSettings.activePresetId === BUILTIN_AGENT_PRESET_ID
      ? "系统默认"
      : (presetSettings.presets.find((preset) => preset.id === presetSettings.activePresetId)
          ?.name ?? "系统默认");
  return (
    <div className="ste:flex ste:flex-col ste:gap-3">
      <div className="ste:grid ste:gap-3 ste:sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="task-cleaning-rule">清洗规则</FieldLabel>
          <NativeSelect
            id="task-cleaning-rule"
            className="ste:w-full"
            value={cleaningSelection ?? ""}
            disabled={disabled}
            onChange={(event) => onCleaningChange(event.target.value || undefined)}
          >
            <option value="">不使用清洗规则</option>
            {cleaningMissing && <option value={cleaningSelection}>所选规则已不存在</option>}
            {rules.map((rule) => (
              <option key={rule.id} value={rule.id}>
                {rule.name}
                {rule.enabled ? "" : "（已停用）"}
              </option>
            ))}
          </NativeSelect>
          <FieldDescription>只清洗填表输入中的 AI 输出。</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="task-agent-preset">Agent 预设</FieldLabel>
          <NativeSelect
            id="task-agent-preset"
            className="ste:w-full"
            value={presetOverride ?? ""}
            disabled={disabled}
            onChange={(event) => onPresetChange(event.target.value || undefined)}
          >
            <option value="">跟随全局（{globalPreset}）</option>
            <option value={BUILTIN_AGENT_PRESET_ID}>系统默认</option>
            {presetSettings.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
            {presetStale && <option value={presetOverride}>所选预设已不存在</option>}
          </NativeSelect>
          <FieldDescription>只影响当前对话的填表任务。</FieldDescription>
        </Field>
      </div>
      <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2 ste:rounded-lg ste:bg-muted/50 ste:px-3 ste:py-2">
        <p className="ste:min-w-0 ste:text-xs ste:text-muted-foreground">
          自动填表：{autoFillSummary}
        </p>
        <Button
          variant="ghost"
          size="sm"
          aria-label="配置对话自动填表"
          disabled={disabled}
          onClick={onOpenAutoFill}
        >
          <Settings2 data-icon="inline-start" />
          调整
        </Button>
      </div>
      {error ? (
        <p role="alert" className="ste:text-xs ste:text-destructive">
          {error}
        </p>
      ) : notice ? (
        <p role="status" className="ste:text-xs ste:text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
