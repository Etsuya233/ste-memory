// Adapted from the official shadcn base-luma registry.
"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "./utils.ts";

import { CheckIcon } from "lucide-react";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "ste:peer ste:relative ste:flex ste:size-4 ste:shrink-0 ste:items-center ste:justify-center ste:rounded-[5px] ste:border ste:border-transparent ste:bg-input/90 ste:transition-shadow ste:outline-none ste:group-has-disabled/field:opacity-50 ste:group-has-[:focus-visible]/field-label:ring-0 ste:group-has-[:focus-visible]/field-label:not-data-checked:border-transparent ste:after:absolute ste:after:-inset-x-3 ste:after:-inset-y-2 ste:focus-visible:border-ring ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:disabled:cursor-not-allowed ste:disabled:opacity-50 ste:aria-invalid:border-destructive ste:aria-invalid:ring-3 ste:aria-invalid:ring-destructive/20 ste:aria-invalid:aria-checked:border-primary ste:dark:aria-invalid:border-destructive/50 ste:dark:aria-invalid:ring-destructive/40 ste:data-checked:border-primary ste:data-checked:bg-primary ste:data-checked:text-primary-foreground ste:group-has-[:focus-visible]/field-label:data-checked:border-primary ste:dark:data-checked:bg-primary",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="ste:grid ste:place-content-center ste:text-current ste:transition-none ste:[&>svg]:size-3.5"
      >
        <CheckIcon />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
