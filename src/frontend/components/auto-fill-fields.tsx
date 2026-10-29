import type { AutoFillSettings } from "../../features/fill-tasks/auto-fill-settings.ts";
import { Input } from "../../ui/primitives/input.tsx";
import { NativeSelect } from "../../ui/primitives/native-select.tsx";
import { Field, FieldLabel, FieldDescription } from "../../ui/primitives/field.tsx";
import { SwitchField } from "./form-fields.tsx";

export const AUTO_FILL_NUMERIC_FIELDS = [
  ["delayFloors", "延迟填写楼层数", 0],
  ["interval", "触发间隔（层）", 1],
  ["blockSize", "每批楼层数", 1],
  ["retries", "每次请求额外重试次数", 0],
  ["retryDelaySeconds", "首次重试等待（秒）", 1],
  ["keepRecentFloors", "隐藏时保留最近楼层数", 0],
] as const;

export function AutoFillFields(
  props: {
    idPrefix: string;
    disabled?: boolean;
  } & (
    | { kind: "global"; value: AutoFillSettings; onChange: (value: AutoFillSettings) => void }
    | {
        kind: "overrides";
        value: Partial<AutoFillSettings>;
        onChange: (value: Partial<AutoFillSettings>) => void;
      }
  ),
) {
  const inherited = props.kind === "overrides";
  function change(patch: Partial<AutoFillSettings>) {
    if (props.kind === "global") props.onChange({ ...props.value, ...patch });
    else
      props.onChange(
        Object.fromEntries(
          Object.entries({ ...props.value, ...patch }).filter(([, value]) => value !== undefined),
        ),
      );
  }
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${props.idPrefix}-mode`}>触发模式</FieldLabel>
        <NativeSelect
          id={`${props.idPrefix}-mode`}
          disabled={props.disabled}
          value={props.value.mode ?? ""}
          onChange={(event) =>
            change({
              mode:
                event.target.value === ""
                  ? undefined
                  : (event.target.value as AutoFillSettings["mode"]),
            })
          }
        >
          {inherited && <option value="">跟随全局</option>}
          <option value="off">关闭</option>
          <option value="remind">仅提醒</option>
          <option value="auto">自动填表</option>
        </NativeSelect>
      </Field>
      {inherited ? (
        <Field>
          <FieldLabel htmlFor={`${props.idPrefix}-hideAfterSuccess`}>成功后自动隐藏楼层</FieldLabel>
          <NativeSelect
            id={`${props.idPrefix}-hideAfterSuccess`}
            disabled={props.disabled}
            value={
              props.value.hideAfterSuccess === undefined ? "" : String(props.value.hideAfterSuccess)
            }
            onChange={(event) =>
              change({
                hideAfterSuccess:
                  event.target.value === "" ? undefined : event.target.value === "true",
              })
            }
          >
            <option value="">跟随全局</option>
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </NativeSelect>
        </Field>
      ) : (
        <SwitchField
          label="成功后自动隐藏楼层"
          checked={props.value.hideAfterSuccess}
          disabled={props.disabled}
          onCheckedChange={(checked) => change({ hideAfterSuccess: checked })}
        />
      )}
      {AUTO_FILL_NUMERIC_FIELDS.map(([key, label, min]) => (
        <Field key={key}>
          <FieldLabel htmlFor={`${props.idPrefix}-${key}`}>{label}</FieldLabel>
          <Input
            id={`${props.idPrefix}-${key}`}
            type="number"
            min={min}
            step={1}
            required={!inherited}
            disabled={props.disabled}
            aria-describedby={
              key === "keepRecentFloors"
                ? `${props.idPrefix}-hide-description`
                : key === "delayFloors"
                  ? `${props.idPrefix}-delay-description`
                  : undefined
            }
            placeholder={inherited ? "留空跟随全局" : undefined}
            value={
              props.value[key] === undefined || Number.isNaN(props.value[key])
                ? ""
                : props.value[key]
            }
            onChange={(event) =>
              change({
                [key]:
                  event.target.value === ""
                    ? inherited
                      ? undefined
                      : NaN
                    : Number(event.target.value),
              })
            }
          />
          {key === "delayFloors" ? (
            <FieldDescription id={`${props.idPrefix}-delay-description`}>
              以最新完成的 AI 楼层为基准，暂留最近 N 层；0 表示包含该 AI 楼层。用户和 AI
              消息均计数，达到触发间隔后填写更早的待填楼层。
            </FieldDescription>
          ) : key === "keepRecentFloors" ? (
            <FieldDescription id={`${props.idPrefix}-hide-description`}>
              仅在整次自动填表成功并保存后隐藏已填楼层，用户和 AI 消息均计数；保留数可设为
              0。关闭后已隐藏楼层保持原样，可通过 ST 的 /unhide 恢复。
            </FieldDescription>
          ) : null}
        </Field>
      ))}
    </>
  );
}
