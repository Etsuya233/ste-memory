// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import * as React from "react";
import { cn } from "./utils.ts";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "ste:flex ste:field-sizing-content ste:min-h-16 ste:w-full ste:resize-none ste:rounded-2xl ste:border ste:border-transparent ste:bg-input/50 ste:px-3 ste:py-3 ste:text-base ste:transition-[color,box-shadow,background-color] ste:outline-none ste:placeholder:text-muted-foreground ste:focus-visible:border-ring ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:disabled:cursor-not-allowed ste:disabled:opacity-50 ste:aria-invalid:border-destructive ste:aria-invalid:ring-3 ste:aria-invalid:ring-destructive/20 ste:md:text-sm ste:dark:aria-invalid:border-destructive/50 ste:dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
