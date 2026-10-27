// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "./utils.ts";

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "ste:peer ste:group/switch ste:relative ste:inline-flex ste:shrink-0 ste:items-center ste:rounded-full ste:border-2 ste:transition-all ste:outline-none ste:group-has-[:focus-visible]/field-label:ring-0 ste:after:absolute ste:after:-inset-x-3 ste:after:-inset-y-2 ste:focus-visible:border-ring ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:aria-invalid:border-destructive ste:aria-invalid:ring-3 ste:aria-invalid:ring-destructive/20 ste:data-[size=default]:h-5 ste:data-[size=default]:w-11 ste:data-[size=sm]:h-4 ste:data-[size=sm]:w-7 ste:dark:aria-invalid:border-destructive/50 ste:dark:aria-invalid:ring-destructive/40 ste:data-checked:border-primary ste:data-checked:bg-primary ste:group-has-[:focus-visible]/field-label:data-checked:border-primary ste:data-unchecked:border-transparent ste:data-unchecked:bg-input/90 ste:group-has-[:focus-visible]/field-label:data-unchecked:border-transparent ste:data-disabled:cursor-not-allowed ste:data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="ste:pointer-events-none ste:block ste:rounded-full ste:bg-background ste:shadow-sm ste:ring-0 ste:transition-transform ste:not-dark:bg-clip-padding ste:group-data-[size=default]/switch:h-4 ste:group-data-[size=default]/switch:w-6 ste:group-data-[size=sm]/switch:h-3 ste:group-data-[size=sm]/switch:w-4 ste:data-checked:translate-x-[calc(100%-8px)] ste:dark:data-checked:bg-primary-foreground ste:data-unchecked:translate-x-0 ste:dark:data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
