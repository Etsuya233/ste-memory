// Adapted from the official shadcn base-luma registry.
"use client";

import * as React from "react";
import { cn } from "./utils.ts";

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "ste:flex ste:items-center ste:gap-2 ste:text-sm ste:leading-none ste:font-medium ste:select-none ste:group-data-[disabled=true]:pointer-events-none ste:group-data-[disabled=true]:opacity-50 ste:peer-disabled:cursor-not-allowed ste:peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
