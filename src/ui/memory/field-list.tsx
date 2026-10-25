import { Switch } from "../kit/controls.tsx";
import { ListGroup, NavigationRow } from "../kit/list.tsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

/** Shared field navigation keeps table and preset fields in the same grouped list. */
export function FieldList(props: { readonly children: ReactNode }) {
  return (
    <ListGroup as="ul" className="stm-field-list">
      {props.children}
    </ListGroup>
  );
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
      <NavigationRow
        {...props.button}
        className="stm-field-main"
        title={
          <>
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
          </>
        }
        description={`${props.fieldKey} · ${props.typeLabel}`}
      />
      {props.toggle && (
        <Switch
          className={props.dependent ? "is-disabled" : ""}
          title={props.dependent ? "该字段被显示策略依赖，不能停用" : undefined}
          aria-label={`启用字段 ${props.name}`}
          {...props.toggle}
        />
      )}
      {props.actions}
    </li>
  );
}
