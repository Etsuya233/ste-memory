// Adapted from shadcn/ui base-luma registry; isolated for embedded hosts.
"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Textarea } from "./textarea.tsx";

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "ste:group/input-group ste:relative ste:flex ste:h-9 ste:w-full ste:min-w-0 ste:items-center ste:rounded-4xl ste:border ste:border-transparent ste:bg-input/50 ste:transition-[color,box-shadow,background-color] ste:outline-none ste:in-data-[slot=combobox-content]:focus-within:border-inherit ste:in-data-[slot=combobox-content]:focus-within:ring-0 ste:has-data-[align=block-end]:rounded-3xl ste:has-data-[align=block-start]:rounded-3xl ste:has-[[data-slot=input-group-control]:focus-visible]:border-ring ste:has-[[data-slot=input-group-control]:focus-visible]:ring-3 ste:has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30 ste:has-[[data-slot][aria-invalid=true]]:border-destructive ste:has-[[data-slot][aria-invalid=true]]:ring-3 ste:has-[[data-slot][aria-invalid=true]]:ring-destructive/20 ste:has-[textarea]:rounded-2xl ste:has-[>[data-align=block-end]]:h-auto ste:has-[>[data-align=block-end]]:flex-col ste:has-[>[data-align=block-start]]:h-auto ste:has-[>[data-align=block-start]]:flex-col ste:has-[>textarea]:h-auto ste:dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 ste:has-[>[data-align=block-end]]:[&>input]:pt-3 ste:has-[>[data-align=block-start]]:[&>input]:pb-3 ste:has-[>[data-align=inline-end]]:[&>input]:pr-1.5 ste:has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "ste:flex ste:h-auto ste:cursor-text ste:items-center ste:justify-center ste:gap-2 ste:py-2 ste:text-sm ste:font-medium ste:text-muted-foreground ste:select-none ste:group-data-[disabled=true]/input-group:opacity-50 ste:**:data-[slot=kbd]:rounded-3xl ste:**:data-[slot=kbd]:bg-muted-foreground/10 ste:**:data-[slot=kbd]:px-1.5 ste:[&>svg:not([class*='size-'])]:size-4",
  {
    variants: {
      align: {
        "inline-start": "ste:order-first ste:pl-3 ste:has-[>button]:-ml-1 ste:has-[>kbd]:-ml-1",
        "inline-end": "ste:order-last ste:pr-3 ste:has-[>button]:-mr-1 ste:has-[>kbd]:-mr-1",
        "block-start":
          "ste:order-first ste:w-full ste:justify-start ste:px-3 ste:pt-3 ste:group-has-[>input]/input-group:pt-3.5 ste:[.border-b]:pb-3.5",
        "block-end":
          "ste:order-last ste:w-full ste:justify-start ste:px-3 ste:pb-3 ste:group-has-[>input]/input-group:pb-3.5 ste:[.border-t]:pt-3.5",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector<HTMLElement>("input, textarea")?.focus();
      }}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva(
  "ste:flex ste:items-center ste:gap-2 ste:rounded-4xl ste:text-sm ste:shadow-none",
  {
    variants: {
      size: {
        xs: "ste:h-6 ste:gap-1 ste:rounded-xl ste:px-1.5 ste:[&>svg:not([class*='size-'])]:size-3.5",
        sm: "",
        "icon-xs": "ste:size-6 ste:rounded-xl ste:p-0 ste:has-[>svg]:p-0",
        "icon-sm": "ste:size-8 ste:p-0 ste:has-[>svg]:p-0",
      },
    },
    defaultVariants: {
      size: "xs",
    },
  },
);

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
  VariantProps<typeof inputGroupButtonVariants> & {
    type?: "button" | "submit" | "reset";
  }) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "ste:flex ste:items-center ste:gap-2 ste:text-sm ste:text-muted-foreground ste:[&_svg]:pointer-events-none ste:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "ste:flex-1 ste:rounded-none ste:border-0 ste:bg-transparent ste:shadow-none ste:ring-0 ste:focus-visible:ring-0 ste:aria-invalid:ring-0 ste:dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "ste:flex-1 ste:resize-none ste:rounded-none ste:border-0 ste:bg-transparent ste:py-2.5 ste:shadow-none ste:ring-0 ste:focus-visible:ring-0 ste:aria-invalid:ring-0 ste:dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
};
