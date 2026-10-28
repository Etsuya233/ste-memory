import type { ComponentProps, ReactNode } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  LoaderCircle,
  Moon,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../ui/primitives/button.tsx";
import { cn } from "../../ui/primitives/utils.ts";

export interface PageControls {
  onClose: () => void;
  onToggleTone: () => void;
}

export function PageHeader({
  title,
  subtitle,
  icon: Icon = BookOpen,
  onBack,
  backLabel = "返回",
  backAction = "page-back",
  actions,
  onClose,
  onToggleTone,
  busy = false,
}: PageControls & {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  onBack?: () => void;
  backLabel?: string;
  backAction?: string;
  actions?: ReactNode;
  busy?: boolean;
}) {
  return (
    <header className="ste:flex ste:shrink-0 ste:items-center ste:gap-3 ste:border-b ste:border-border ste:px-4 ste:py-3 ste:pt-[max(0.75rem,env(safe-area-inset-top))]">
      {onBack ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={backLabel}
          data-action={backAction}
          disabled={busy}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
      ) : (
        <Icon className="ste:size-5 ste:shrink-0" />
      )}
      <div className="ste:min-w-0 ste:flex-1">
        <h1 className="ste:text-sm ste:font-semibold">{title}</h1>
        {subtitle ? (
          <p
            data-testid="chat-title"
            className="ste:truncate ste:text-xs ste:text-muted-foreground"
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions}
      <Button variant="ghost" size="icon" aria-label="切换亮暗色" onClick={onToggleTone}>
        <Sun className="ste:dark:hidden" />
        <Moon className="ste:hidden ste:dark:block" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="收起工作台"
        data-action="close-frontend"
        disabled={busy}
        onClick={onClose}
      >
        <X />
      </Button>
    </header>
  );
}

export function PageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "ste:min-h-0 ste:flex-1 ste:overflow-y-auto ste:overscroll-contain ste:p-4",
        className,
      )}
      {...props}
    />
  );
}

export function PageFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn(
        "ste:flex ste:shrink-0 ste:items-center ste:justify-between ste:gap-3 ste:border-t ste:border-border ste:bg-background ste:p-4",
        className,
      )}
      {...props}
    />
  );
}

export function SaveActions({
  formId,
  busy,
  dirty,
  disabled = false,
  onCancel,
  saveLabel = "保存",
  saveAction = "save-changes",
}: {
  formId: string;
  busy: boolean;
  dirty: boolean;
  disabled?: boolean;
  onCancel: () => void;
  saveLabel?: string;
  saveAction?: string;
}) {
  return (
    <PageFooter>
      <p role="status" className="ste:text-xs ste:text-muted-foreground">
        {busy ? "正在保存…" : dirty ? "有未保存修改" : "尚未修改"}
      </p>
      <div className="ste:flex ste:gap-2">
        <Button variant="outline" data-action="cancel-edit" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          type="submit"
          form={formId}
          data-action={saveAction}
          disabled={busy || !dirty || disabled}
        >
          {busy ? (
            <LoaderCircle data-icon="inline-start" className="ste:animate-spin" />
          ) : (
            <Check data-icon="inline-start" />
          )}
          {saveLabel}
        </Button>
      </div>
    </PageFooter>
  );
}
