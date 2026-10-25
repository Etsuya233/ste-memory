import { ActionMenu } from "../kit/action-menu.tsx";
import { PanelBarAction } from "../shell/panel-bar.tsx";

export interface SettingsMenuAction {
  readonly label: string;
  readonly dataAction: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
}

/** The host supplies its icon button; positioning and keyboard behavior live in the kit. */
export function SettingsActionMenu(props: {
  readonly label?: string;
  readonly actions: readonly SettingsMenuAction[];
}) {
  return (
    <ActionMenu
      label={props.label}
      actions={props.actions.map((action) => ({ ...action, id: action.dataAction }))}
      renderTrigger={({ "aria-label": label, ...attributes }) => (
        <PanelBarAction
          {...attributes}
          icon="fa-ellipsis"
          label={label!}
          data-action="settings-more"
        />
      )}
    />
  );
}
