import { Input } from "../kit/controls.tsx";
import { useId, useState } from "react";
import type { AutoFillService } from "../../features/fill-tasks/auto-fill-service.ts";
import type { AutoFillSettings } from "../../features/fill-tasks/auto-fill-settings.ts";
import { reportError } from "../shell/ui-helpers.tsx";

export const AUTO_FILL_MODE_LABELS = { off: "关闭", remind: "仅提醒", auto: "自动填表" };
const NUMERIC_FIELDS = [
  ["delayFloors", "延迟填写楼层数", 0],
  ["interval", "触发间隔（层）", 1],
  ["blockSize", "每批楼层数", 1],
  ["retries", "每次 API 请求额外重试次数", 0],
  ["retryDelaySeconds", "首次重试等待（秒，后续翻倍）", 1],
  ["keepRecentFloors", "隐藏时保留最近楼层数", 0],
] as const;

export function AutoFillFields(props: {
  readonly values: Partial<AutoFillSettings>;
  readonly defaults?: AutoFillSettings;
  readonly onChange: (values: Partial<AutoFillSettings>) => void;
}) {
  const hideDescriptionId = useId();
  function change(key: keyof AutoFillSettings, value: string): void {
    const next = { ...props.values };
    if (value === "") delete next[key];
    else if (key === "mode") next.mode = value as AutoFillSettings["mode"];
    else if (key === "hideAfterSuccess") next[key] = value === "true";
    else Object.assign(next, { [key]: Number(value) });
    props.onChange(next);
  }
  return (
    <div className="stm-task-form stm-auto-fill-fields">
      <label className="stm-task-field">
        <span>运行模式</span>
        <select
          className="stm-select"
          data-auto-fill="mode"
          value={props.values.mode ?? ""}
          onChange={(event) => change("mode", event.target.value)}
        >
          {props.defaults && (
            <option value="">{AUTO_FILL_MODE_LABELS[props.defaults.mode]}（全局）</option>
          )}
          {Object.entries(AUTO_FILL_MODE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="stm-task-field">
        <span>成功后自动隐藏楼层</span>
        <select
          className="stm-select"
          data-auto-fill="hideAfterSuccess"
          aria-describedby={hideDescriptionId}
          value={
            props.values.hideAfterSuccess === undefined ? "" : String(props.values.hideAfterSuccess)
          }
          onChange={(event) => change("hideAfterSuccess", event.target.value)}
        >
          {props.defaults && (
            <option value="">{props.defaults.hideAfterSuccess ? "开启" : "关闭"}（全局）</option>
          )}
          <option value="false">关闭</option>
          <option value="true">开启</option>
        </select>
      </label>
      {NUMERIC_FIELDS.map(([key, label, min]) => (
        <label className="stm-task-field" key={key}>
          <span>{label}</span>
          <Input
            type="number"
            min={min}
            step="1"
            data-auto-fill={key}
            aria-describedby={key === "keepRecentFloors" ? hideDescriptionId : undefined}
            key={`${key}:${props.values[key] ?? ""}`}
            defaultValue={props.values[key] ?? ""}
            placeholder={props.defaults ? String(props.defaults[key]) : undefined}
            onBlur={(event) => {
              const input = event.currentTarget;
              if (!input.validity.valid || (input.value === "" && !props.defaults)) {
                input.reportValidity();
                input.value = String(props.values[key] ?? "");
                return;
              }
              change(key, input.value);
            }}
          />
        </label>
      ))}
      <p id={hideDescriptionId} className="stm-task-hint stm-task-field--grow">
        整次自动填表成功并保存后，隐藏 #0 至 min(当前楼层 − 保留数, 最大已填楼层)。 用户和 AI
        消息均计数，范围包含两端；关闭后已隐藏楼层保持原样，可通过 ST unhide 恢复。
      </p>
    </div>
  );
}

export function AutoFillControls(props: {
  readonly service: AutoFillService;
  readonly defaults: AutoFillSettings;
}) {
  const [, update] = useState(0);
  const state = props.service.read();
  return (
    <div className="stm-task-card" data-stm-section="auto-fill">
      <div className="stm-task-card-title">自动填表</div>
      <div className="stm-task-hint">
        留空项使用全局值。用户和 AI 消息均计入楼层，AI 回复完成后检查。
      </div>
      <AutoFillFields
        values={state.overrides}
        defaults={props.defaults}
        onChange={(values) => {
          try {
            props.service.saveOverrides(values);
            update((value) => value + 1);
          } catch (error) {
            reportError(error);
          }
        }}
      />
    </div>
  );
}
