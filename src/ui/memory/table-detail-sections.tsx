import { ActionGroup } from "../kit/actions.tsx";
import { ListGroup, ListRow, ListSection, NavigationRow } from "../kit/list.tsx";
import type { ReactNode } from "react";

/** 表格详情左侧的字段工具栏与列表外壳，表格页与预设详情/编辑共用。 */
export function TableFieldsPanel(props: {
  readonly status: ReactNode;
  readonly actions?: ReactNode;
  readonly emptyTitle?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="stm-fields-panel">
      <div className="stm-fields-toolbar">
        <div className="stm-fields-title">{props.status}</div>
        {props.actions ? (
          <ActionGroup className="stm-fields-actions">{props.actions}</ActionGroup>
        ) : null}
      </div>
      {props.children ?? (
        <div className="stm-fields-empty">
          <div className="stm-fields-empty-title">{props.emptyTitle ?? "还没有字段"}</div>
        </div>
      )}
    </div>
  );
}

export interface TableConfigItem {
  readonly key: string;
  readonly title: string;
  readonly summary: ReactNode;
  /** 有 onClick 时渲染为入口行；否则渲染为只读摘要行。 */
  readonly onClick?: () => void;
  readonly action?: string;
  readonly tableId?: string;
  readonly disabled?: boolean;
}

/** “表格配置”静态分组列表：表格页、预设详情与预设编辑共用同一视觉和顺序。 */
export function TableConfigSection(props: {
  readonly items: readonly TableConfigItem[];
  readonly label?: string;
  readonly meta?: ReactNode;
}) {
  const label = props.label ?? "表格配置";
  return (
    <ListSection
      className="stm-table-settings"
      title={
        <>
          {label}
          {props.meta != null && props.meta !== "" ? ` · ${props.meta}` : ""}
        </>
      }
    >
      <ListGroup as="ul" className="stm-settings-item-list">
        {props.items.map((item) => (
          <li key={item.key}>
            {item.onClick ? (
              <NavigationRow
                title={item.title}
                description={item.summary}
                data-action={item.action}
                data-table-id={item.tableId}
                disabled={item.disabled}
                onClick={item.onClick}
              />
            ) : (
              <ListRow title={item.title} description={item.summary} />
            )}
          </li>
        ))}
      </ListGroup>
    </ListSection>
  );
}
