import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "../../../ui/primitives/button.tsx";
import { Input } from "../../../ui/primitives/input.tsx";
import {
  PageContent,
  PageHeader,
  SaveActions,
  type PageControls,
} from "../../components/page-layout.tsx";
import { usePageLeave, type RegisterLeaveGuard } from "../../components/confirmation.tsx";
import { StatusNotice } from "../../components/page-state.tsx";
import type { SettingsServices } from "./settings-actions.ts";

export interface SettingsSubpageProps {
  services: SettingsServices;
  controls: PageControls;
  onBack: () => void;
  registerLeaveGuard?: RegisterLeaveGuard;
}

/** All connection forms share save placement, dirty navigation and refresh protection. */
export function SettingsEditor({
  title,
  subtitle = "全局设置",
  scope,
  controls,
  onBack,
  registerLeaveGuard,
  dirty,
  navigationDirty = dirty,
  busy,
  onDiscard,
  onSave,
  error,
  notice,
  children,
}: Omit<SettingsSubpageProps, "services"> & {
  title: string;
  subtitle?: string;
  scope: string;
  dirty: boolean;
  navigationDirty?: boolean;
  busy: boolean;
  onDiscard: () => void;
  onSave: () => void;
  error?: string | null;
  notice?: string | null;
  children: ReactNode;
}) {
  const { requestLeave, confirmation } = usePageLeave({
    dirty: navigationDirty,
    busy,
    scope,
    discard: onDiscard,
    register: registerLeaveGuard,
  });
  useEffect(() => {
    if (!navigationDirty && !busy) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [navigationDirty, busy]);
  const back = () => requestLeave(onBack);
  return (
    <div className="ste:flex ste:h-full ste:min-h-0 ste:flex-col">
      <PageHeader title={title} subtitle={subtitle} {...controls} onBack={back} busy={busy} />
      <PageContent>
        <form
          id={scope}
          className="ste:flex ste:flex-col ste:gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && dirty) onSave();
          }}
        >
          {error ? <StatusNotice variant="destructive">{error}</StatusNotice> : null}
          {notice ? <StatusNotice>{notice}</StatusNotice> : null}
          <fieldset
            disabled={busy}
            className="ste:flex ste:min-w-0 ste:flex-col ste:gap-5 ste:border-0 ste:p-0"
          >
            {children}
          </fieldset>
        </form>
      </PageContent>
      <SaveActions formId={scope} busy={busy} dirty={dirty} onCancel={back} />
      {confirmation}
    </div>
  );
}

export function SecretInput({ label, ...props }: ComponentProps<"input"> & { label: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="ste:flex ste:min-w-0 ste:items-center ste:gap-2">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        autoComplete="off"
        className="ste:flex-1"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`${visible ? "隐藏" : "显示"}${label}`}
        aria-pressed={visible}
        disabled={props.disabled}
        onClick={() => setVisible(!visible)}
      >
        {visible ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}
