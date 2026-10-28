import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "../../ui/primitives/alert-dialog.tsx";
import { Alert, AlertDescription } from "../../ui/primitives/alert.tsx";

export type NavigationGuard = (action: () => void) => void;
export type RegisterLeaveGuard = (guard: NavigationGuard | null) => void;

export function ConfirmAction({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "取消",
  onConfirm,
  destructive = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  destructive?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const operation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    operation.current++;
    setBusy(false);
    setError(null);
    return () => {
      operation.current++;
    };
  }, [open]);
  async function confirm() {
    if (busy) return;
    const token = ++operation.current;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      if (token === operation.current) onOpenChange(false);
    } catch (cause) {
      if (token === operation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (token === operation.current) setBusy(false);
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent initialFocus={cancel}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancel} disabled={busy}>
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "处理中…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One navigation policy for header back, bottom navigation and panel close. */
export function usePageLeave({
  dirty,
  busy,
  scope,
  discard,
  register,
}: {
  dirty: boolean;
  busy: boolean;
  scope: string;
  discard: () => void;
  register?: RegisterLeaveGuard;
}) {
  const latest = useRef({ dirty, busy, discard, scope });
  latest.current = { dirty, busy, discard, scope };
  const [pending, setPending] = useState<{ scope: string; action: () => void } | null>(null);
  const requestLeave = useCallback<NavigationGuard>((action) => {
    if (latest.current.busy) return;
    if (latest.current.dirty) setPending({ scope: latest.current.scope, action });
    else action();
  }, []);
  useEffect(() => {
    register?.(requestLeave);
    return () => register?.(null);
  }, [register, requestLeave]);
  useEffect(() => {
    setPending(null);
  }, [scope]);
  const confirmation = (
    <ConfirmAction
      open={pending !== null && pending.scope === scope}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title="放弃这次修改？"
      description="尚未保存的内容会被丢弃。你也可以保留编辑，完成后再离开。"
      cancelLabel="保留编辑"
      confirmLabel="放弃修改并继续"
      destructive
      onConfirm={() => {
        if (pending?.scope !== latest.current.scope) return;
        const action = pending.action;
        latest.current.discard();
        latest.current.dirty = false;
        setPending(null);
        action();
      }}
    />
  );
  return { requestLeave, confirmation };
}
