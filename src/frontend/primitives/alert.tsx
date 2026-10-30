// Adapted from the official shadcn base-luma registry.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

const alertVariants = cva(
  "ste:group/alert ste:relative ste:grid ste:w-full ste:gap-0.5 ste:rounded-2xl ste:border ste:px-4 ste:py-3 ste:text-left ste:text-sm ste:has-data-[slot=alert-action]:relative ste:has-data-[slot=alert-action]:pr-18 ste:has-[>svg]:grid-cols-[auto_1fr] ste:has-[>svg]:gap-x-2.5 ste:*:[svg]:row-span-2 ste:*:[svg]:translate-y-0.5 ste:*:[svg]:text-current ste:*:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "ste:bg-card ste:text-card-foreground",
        destructive:
          "ste:bg-card ste:text-destructive ste:*:data-[slot=alert-description]:text-destructive/90 ste:*:[svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "ste:font-medium ste:group-has-[>svg]/alert:col-start-2 ste:[&_a]:underline ste:[&_a]:underline-offset-3 ste:[&_a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "ste:text-sm ste:text-balance ste:text-muted-foreground ste:md:text-pretty ste:[&_a]:underline ste:[&_a]:underline-offset-3 ste:[&_a]:hover:text-foreground ste:[&_p:not(:last-child)]:mb-4",
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("ste:absolute ste:top-2.5 ste:right-3", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
