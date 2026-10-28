// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "./utils.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "ste:h-9 ste:w-full ste:min-w-0 ste:rounded-3xl ste:border ste:border-transparent ste:bg-input/50 ste:px-3 ste:py-1 ste:text-base ste:transition-[color,box-shadow,background-color] ste:outline-none ste:file:inline-flex ste:file:h-7 ste:file:border-0 ste:file:bg-transparent ste:file:text-sm ste:file:font-medium ste:file:text-foreground ste:placeholder:text-muted-foreground ste:focus-visible:border-ring ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:disabled:pointer-events-none ste:disabled:cursor-not-allowed ste:disabled:opacity-50 ste:aria-invalid:border-destructive ste:aria-invalid:ring-3 ste:aria-invalid:ring-destructive/20 ste:md:text-sm ste:dark:aria-invalid:border-destructive/50 ste:dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
