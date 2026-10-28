import type { ComponentProps, ReactNode } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Check,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "../primitives/utils.ts";
import { Button } from "../primitives/button.tsx";

/** Host-facing toolbar composition. Portable primitives know nothing about panel slots. */
export function RecordPageAction({
  label,
  icon,
  emphasis,
  danger,
  className,
  ...props
}: ComponentProps<typeof Button> & {
  readonly label: string;
  readonly icon: string;
  readonly emphasis?: boolean;
  readonly danger?: boolean;
}) {
  const Icon =
    (
      {
        "fa-chevron-left": ArrowLeft,
        "fa-chevron-right": ChevronRight,
        "fa-check": Check,
        "fa-spinner": LoaderCircle,
        "fa-pen": Pencil,
        "fa-plus": Plus,
        "fa-trash-can": Trash2,
        "fa-xmark": X,
      } as Record<string, typeof ChevronRight>
    )[icon] ?? ArrowLeft;
  return (
    <Button
      variant={danger ? "destructive" : emphasis ? "default" : "ghost"}
      size="sm"
      className={cn("ste:max-[480px]:size-9 ste:max-[480px]:p-0", className)}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon aria-hidden="true" className={icon === "fa-spinner" ? "ste:animate-spin" : undefined} />
      <span>{label}</span>
    </Button>
  );
}

export function RecordPageBar(props: {
  readonly title: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly variant?: string;
}) {
  return (
    <header className="stm-record-page-bar">
      <div className="stm-record-page-actions">{props.leading}</div>
      <h2>{props.title}</h2>
      <div className="stm-record-page-actions">{props.trailing}</div>
    </header>
  );
}

export function RecordBottomBar(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <footer className="stm-record-bottom-bar" aria-label={props.label}>
      <nav className="stm-record-page-actions" aria-label={props.label}>
        {props.children}
      </nav>
      <div className="stm-record-page-actions">{props.trailing}</div>
    </footer>
  );
}
