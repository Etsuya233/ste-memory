import type { ReactNode } from "react";
import { FileText, type LucideIcon } from "lucide-react";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "../primitives/empty.tsx";
import { Alert, AlertTitle, AlertDescription } from "../primitives/alert.tsx";
import { Button } from "../primitives/button.tsx";

export function PageEmpty({
  title,
  description,
  icon: Icon = FileText,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
export function PageError({
  title = "加载失败",
  error,
  onRetry,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {error}
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            重新加载
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
export function StatusNotice({
  children,
  variant = "default",
}: {
  children: ReactNode;
  variant?: "default" | "destructive";
}) {
  return (
    <Alert variant={variant}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
