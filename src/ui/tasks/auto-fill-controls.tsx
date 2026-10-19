import type { MemorySpaceId } from "../../features/memory/index.ts";
import { useEffect, useState } from "react";
import type { AutoFillService } from "../../features/fill-tasks/auto-fill-service.ts";
import type { AutoFillSettings } from "../../features/fill-tasks/auto-fill-settings.ts";
import type { FillTaskService } from "../../features/fill-tasks/fill-task-service.ts";
import { reportError } from "../shell/ui-helpers.tsx";

export const AUTO_FILL_MODE_LABELS = { off: "关闭", remind: "仅提醒", auto: "自动填表" };
const NUMERIC_FIELDS = [
  ["interval", "触发间隔（层）", 1],
  ["blockSize", "每批楼层数", 1],
  ["retries", "额外重试次数", 0],
  ["retryDelaySeconds", "重试等待（秒）", 1],
] as const;

export function AutoFillFields(props: {
  readonly values: Partial<AutoFillSettings>;
  readonly defaults?: AutoFillSettings;
  readonly onChange: (values: Partial<AutoFillSettings>) => void;
}) {
  function change(key: keyof AutoFillSettings, value: string): void {
    const next = { ...props.values };
    if (value === "") delete next[key];
    else if (key === "mode") next.mode = value as AutoFillSettings["mode"];
    else if (key === "includeCurrent") next.includeCurrent = value === "true";
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
        <span>包含当前 AI 楼层</span>
        <select
          className="stm-select"
          data-auto-fill="includeCurrent"
          value={
            props.values.includeCurrent === undefined ? "" : String(props.values.includeCurrent)
          }
          onChange={(event) => change("includeCurrent", event.target.value)}
        >
          {props.defaults && (
            <option value="">{props.defaults.includeCurrent ? "是" : "否"}（全局）</option>
          )}
          <option value="false">否</option>
          <option value="true">是</option>
        </select>
      </label>
      {NUMERIC_FIELDS.map(([key, label, min]) => (
        <label className="stm-task-field" key={key}>
          <span>{label}</span>
          <input
            className="stm-input"
            type="number"
            min={min}
            step="1"
            data-auto-fill={key}
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
    </div>
  );
}

export function AutoFillControls(props: {
  readonly service: AutoFillService;
  readonly tasks: Pick<FillTaskService, "activeTask" | "retryStates">;
  readonly defaults: AutoFillSettings;
  readonly spaceId: MemorySpaceId;
}) {
  const [, update] = useState(0);
  const [progress, setProgress] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const task = await props.tasks.activeTask(props.spaceId);
      if (disposed) return;
      const waiting = task && props.tasks.retryStates.get(task.runId);
      setProgress(
        waiting
          ? `楼层 #${waiting.from}–#${waiting.to}：第 ${waiting.attempt} 次重试，${Math.max(0, Math.ceil((waiting.retryAt - Date.now()) / 1000))} 秒后开始`
          : task?.automatic
            ? "自动填表运行中"
            : "",
      );
      update((value) => value + 1);
    };
    void refresh().catch(reportError);
    const timer = setInterval(() => void refresh().catch(reportError), 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [props.tasks, props.spaceId]);
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
      {progress && (
        <div className="stm-task-hint" role="status">
          {progress}
        </div>
      )}
      {state.pausedReason && (
        <div role="status" className="stm-task-hint">
          已暂停：{state.pausedReason}{" "}
          <button
            type="button"
            className="stm-button"
            data-action="resume-auto-fill"
            onClick={() => {
              props.service.resume();
              update((value) => value + 1);
            }}
          >
            恢复自动填表
          </button>
        </div>
      )}
    </div>
  );
}
