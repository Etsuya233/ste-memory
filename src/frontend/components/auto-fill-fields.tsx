import type { AutoFillSettings } from "../../features/fill-tasks/auto-fill-settings.ts";
import { Input } from "../../ui/primitives/input.tsx";
import { NativeSelect } from "../../ui/primitives/native-select.tsx";
import { Field, FieldLabel } from "../../ui/primitives/field.tsx";
import { SwitchField } from "./form-fields.tsx";

export const AUTO_FILL_NUMERIC_FIELDS = [
  ["interval", "触发间隔（层）", 1],
  ["blockSize", "每批楼层数", 1],
  ["retries", "每次请求额外重试次数", 0],
  ["retryDelaySeconds", "首次重试等待（秒）", 1],
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
          <FieldLabel htmlFor={`${props.idPrefix}-includeCurrent`}>包含刚完成的 AI 楼层</FieldLabel>
          <NativeSelect
            id={`${props.idPrefix}-includeCurrent`}
            disabled={props.disabled}
            value={
              props.value.includeCurrent === undefined ? "" : String(props.value.includeCurrent)
            }
            onChange={(event) =>
              change({
                includeCurrent:
                  event.target.value === "" ? undefined : event.target.value === "true",
              })
            }
          >
            <option value="">跟随全局</option>
            <option value="true">包含</option>
            <option value="false">不包含</option>
          </NativeSelect>
        </Field>
      ) : (
        <SwitchField
          label="包含刚完成的 AI 楼层"
          checked={props.value.includeCurrent!}
          disabled={props.disabled}
          onCheckedChange={(includeCurrent) => change({ includeCurrent })}
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
        </Field>
      ))}
    </>
  );
}
