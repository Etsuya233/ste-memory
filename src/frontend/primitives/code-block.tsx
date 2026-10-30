// Adapted from shadcn/ui base-luma registry; isolated for embedded hosts.
"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, Copy } from "lucide-react";
import { Button } from "./button.tsx";
import { cn } from "./utils.ts";

const codeBlockVariants = cva(
  "ste:group/code-block ste:relative ste:flex ste:w-full ste:min-w-0 ste:flex-col ste:overflow-hidden ste:rounded-2xl ste:text-sm ste:data-[size=sm]:rounded-xl ste:data-[size=sm]:text-xs",
  {
    variants: {
      variant: {
        default:
          "ste:bg-muted ste:text-foreground ste:ring-1 ste:ring-foreground/5 ste:dark:ring-foreground/10",
        destructive:
          "ste:bg-destructive/5 ste:text-destructive ste:ring-1 ste:ring-destructive/15 ste:dark:bg-destructive/10 ste:dark:ring-destructive/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function CodeBlock({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof codeBlockVariants> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="code-block"
      data-variant={variant}
      data-size={size}
      className={cn(codeBlockVariants({ variant }), className)}
      {...props}
    />
  );
}

function CodeBlockHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-header"
      className={cn(
        "ste:flex ste:min-w-0 ste:shrink-0 ste:items-center ste:gap-2 ste:px-4 ste:pt-3 ste:text-muted-foreground ste:group-data-[size=sm]/code-block:px-3 ste:group-data-[size=sm]/code-block:pt-2.5 ste:group-data-[variant=destructive]/code-block:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function CodeBlockTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-title"
      className={cn(
        "ste:min-w-0 ste:truncate ste:text-xs ste:font-medium ste:text-foreground ste:group-data-[variant=destructive]/code-block:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function CodeBlockActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-actions"
      className={cn(
        "ste:ms-auto ste:flex ste:shrink-0 ste:items-center ste:gap-1 ste:[&_[data-slot=button]]:text-muted-foreground ste:[&_[data-slot=button]:hover]:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CodeBlockContent({
  className,
  wrap = false,
  ...props
}: React.ComponentProps<"pre"> & { wrap?: boolean }) {
  return (
    <pre
      data-slot="code-block-content"
      data-wrap={wrap || undefined}
      dir="ltr"
      tabIndex={0}
      className={cn(
        "ste:min-h-0 ste:min-w-0 ste:overflow-auto ste:px-4 ste:py-3 ste:font-mono ste:text-xs ste:leading-relaxed ste:outline-none ste:group-data-[size=sm]/code-block:px-3 ste:group-data-[size=sm]/code-block:py-2.5 ste:data-[wrap]:whitespace-pre-wrap ste:data-[wrap]:break-words ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30",
        className,
      )}
      {...props}
    />
  );
}

function CodeBlockCopyButton({
  value,
  copy,
  onCopyError,
  className,
  ...props
}: React.ComponentProps<typeof Button> & {
  value: string;
  /** Host clipboard bridge; falls back to the async Clipboard API. */
  copy?: () => void | Promise<void>;
  onCopyError?: (message: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <>
      <Button
        type="button"
        data-slot="code-block-copy-button"
        data-copied={copied || undefined}
        variant="ghost"
        size="icon-xs"
        aria-label={copied ? "已复制" : "复制"}
        className={cn("ste:text-muted-foreground ste:hover:text-foreground", className)}
        onClick={async () => {
          try {
            if (copy) await copy();
            else await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch (cause) {
            onCopyError?.(cause instanceof Error ? cause.message : String(cause));
          }
        }}
        {...props}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
      <span aria-live="polite" className="ste:sr-only">
        {copied ? "已复制" : ""}
      </span>
    </>
  );
}

function CodeBlockFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="code-block-footer"
      className={cn(
        "ste:flex ste:min-w-0 ste:shrink-0 ste:items-center ste:gap-2 ste:px-4 ste:pb-3 ste:text-muted-foreground ste:group-data-[size=sm]/code-block:px-3 ste:group-data-[size=sm]/code-block:pb-2.5",
        className,
      )}
      {...props}
    />
  );
}

export {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
  CodeBlockFooter,
};
