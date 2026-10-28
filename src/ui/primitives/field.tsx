// Adapted from the official shadcn base-luma registry.
"use client";

import { useMemo } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

import { Label } from "./label.tsx";
import { Separator } from "./separator.tsx";

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "ste:flex ste:flex-col ste:gap-6 ste:has-[>[data-slot=checkbox-group]]:gap-3 ste:has-[>[data-slot=radio-group]]:gap-3",
        className,
      )}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: React.ComponentProps<"legend"> & { variant?: "legend" | "label" }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "ste:mb-3 ste:font-medium ste:data-[variant=label]:text-sm ste:data-[variant=legend]:text-base",
        className,
      )}
      {...props}
    />
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "ste:group/field-group ste:@container/field-group ste:flex ste:w-full ste:flex-col ste:gap-7 ste:data-[slot=checkbox-group]:gap-3 ste:*:data-[slot=field-group]:gap-4",
        className,
      )}
      {...props}
    />
  );
}

const fieldVariants = cva(
  "ste:group/field ste:flex ste:w-full ste:gap-3 ste:data-[invalid=true]:text-destructive",
  {
    variants: {
      orientation: {
        vertical: "ste:flex-col ste:*:w-full ste:[&>.sr-only]:w-auto",
        horizontal:
          "ste:flex-row ste:items-center ste:has-[>[data-slot=field-content]]:items-start ste:*:data-[slot=field-label]:flex-auto ste:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        responsive:
          "ste:flex-col ste:*:w-full ste:@md/field-group:flex-row ste:@md/field-group:items-center ste:@md/field-group:*:w-auto ste:@md/field-group:has-[>[data-slot=field-content]]:items-start ste:@md/field-group:*:data-[slot=field-label]:flex-auto ste:[&>.sr-only]:w-auto ste:@md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  },
);

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return (
    <div
      role="group"
      data-slot="field"
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      {...props}
    />
  );
}

function FieldContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "ste:group/field-content ste:flex ste:flex-1 ste:flex-col ste:gap-1 ste:leading-snug",
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>) {
  return (
    <Label
      data-slot="field-label"
      className={cn(
        "ste:group/field-label ste:peer/field-label ste:flex ste:w-fit ste:gap-2 ste:leading-snug ste:group-data-[disabled=true]/field:opacity-50 ste:has-data-checked:bg-input/30 ste:has-[>[data-slot=field]]:rounded-2xl ste:has-[>[data-slot=field]]:border ste:has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-input/40 ste:has-[>[data-slot=field]]:has-[:focus-visible]:border-ring ste:has-[>[data-slot=field]]:has-[:focus-visible]:ring-3 ste:has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring/50 ste:*:data-[slot=field]:p-4",
        "ste:has-[>[data-slot=field]]:w-full ste:has-[>[data-slot=field]]:flex-col",
        className,
      )}
      {...props}
    />
  );
}

function FieldTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        "ste:flex ste:w-fit ste:items-center ste:gap-2 ste:text-sm ste:font-medium ste:group-data-[disabled=true]/field:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        "ste:text-left ste:text-sm ste:leading-normal ste:font-normal ste:text-muted-foreground ste:group-has-data-horizontal/field:text-balance ste:[[data-variant=legend]+&]:-mt-1.5",
        "ste:last:mt-0 ste:nth-last-2:-mt-1",
        "ste:[&>a]:underline ste:[&>a]:underline-offset-4 ste:[&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function FieldSeparator({
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  children?: React.ReactNode;
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        "ste:relative ste:-my-2 ste:h-5 ste:text-sm ste:group-data-[variant=outline]/field-group:-mb-2",
        className,
      )}
      {...props}
    >
      <Separator className="ste:absolute ste:inset-0 ste:top-1/2" />
      {children && (
        <span
          className="ste:relative ste:mx-auto ste:block ste:w-fit ste:bg-background ste:px-2 ste:text-muted-foreground"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<"div"> & {
  errors?: Array<{ message?: string } | undefined>;
}) {
  const content = useMemo(() => {
    if (children) {
      return children;
    }

    if (!errors?.length) {
      return null;
    }

    const uniqueErrors = [...new Map(errors.map((error) => [error?.message, error])).values()];

    if (uniqueErrors?.length == 1) {
      return uniqueErrors[0]?.message;
    }

    return (
      <ul className="ste:ml-4 ste:flex ste:list-disc ste:flex-col ste:gap-1">
        {uniqueErrors.map((error, index) => error?.message && <li key={index}>{error.message}</li>)}
      </ul>
    );
  }, [children, errors]);

  if (!content) {
    return null;
  }

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn("ste:text-sm ste:font-normal ste:text-destructive", className)}
      {...props}
    >
      {content}
    </div>
  );
}

export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
};
