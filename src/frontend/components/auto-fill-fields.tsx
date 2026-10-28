import type { AutoFillSettings } from "../../features/fill-tasks/auto-fill-settings.ts";
import { Input } from "../../ui/primitives/input.tsx";
import { NativeSelect } from "../../ui/primitives/native-select.tsx";
import { Field, FieldLabel, FieldDescription } from "../../ui/primitives/field.tsx";
import { SwitchField } from "./form-fields.tsx";

export const AUTO_FILL_NUMERIC_FIELDS = [
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
      {(
        [
          ["includeCurrent", "包含刚完成的 AI 楼层", "包含", "不包含"],
          ["hideAfterSuccess", "成功后自动隐藏楼层", "开启", "关闭"],
        ] as const
      ).map(([key, label, enabled, disabled]) =>
        inherited ? (
          <Field key={key}>
            <FieldLabel htmlFor={`${props.idPrefix}-${key}`}>{label}</FieldLabel>
            <NativeSelect
              id={`${props.idPrefix}-${key}`}
              disabled={props.disabled}
              value={props.value[key] === undefined ? "" : String(props.value[key])}
              onChange={(event) =>
                change({
                  [key]: event.target.value === "" ? undefined : event.target.value === "true",
                })
              }
            >
              <option value="">跟随全局</option>
              <option value="true">{enabled}</option>
              <option value="false">{disabled}</option>
            </NativeSelect>
          </Field>
        ) : (
          <SwitchField
            key={key}
            label={label}
            checked={props.value[key]!}
            disabled={props.disabled}
            onCheckedChange={(checked) => change({ [key]: checked })}
          />
        ),
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
              key === "keepRecentFloors" ? `${props.idPrefix}-hide-description` : undefined
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
          {key === "keepRecentFloors" ? (
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
