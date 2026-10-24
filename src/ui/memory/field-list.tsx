import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Shared field navigation keeps table and preset fields in the same grouped list. */
export function FieldList(props: { readonly children: ReactNode }) {
  return <ul className="stm-field-list stm-grouped-list">{props.children}</ul>;
}

export function FieldListRow(props: {
  readonly name: string;
  readonly fieldKey: string;
  readonly typeLabel: string;
  readonly required: boolean;
  readonly dependent: boolean;
  readonly button: ButtonHTMLAttributes<HTMLButtonElement> & {
    "data-action"?: string;
    "data-table-id"?: string;
    "data-field-id"?: string;
  };
  readonly toggle?: InputHTMLAttributes<HTMLInputElement> & {
    "data-action"?: string;
    "data-table-id"?: string;
    "data-field-id"?: string;
  };
  readonly actions?: ReactNode;
}) {
  return (
    <li className="stm-field-row">
      <button type="button" className="stm-field-main" {...props.button}>
        <span className="stm-field-name">
          {props.name}
          {props.required && (
            <span className="stm-field-required" title="必填">
              *
            </span>
          )}
          {props.dependent && (
            <span className="stm-field-dep" title="该字段被显示策略依赖，请先修改显示策略">
              显示策略依赖
            </span>
          )}
        </span>
        <span className="stm-field-tag">
          {props.fieldKey} · {props.typeLabel}
        </span>
      </button>
      {props.toggle && (
        <label
          className={`stm-switch${props.dependent ? " is-disabled" : ""}`}
          title={props.dependent ? "该字段被显示策略依赖，不能停用" : undefined}
        >
          <input type="checkbox" aria-label={`启用字段 ${props.name}`} {...props.toggle} />
          <span className="stm-switch-track" aria-hidden="true" />
        </label>
      )}
      {props.actions}
    </li>
  );
}
