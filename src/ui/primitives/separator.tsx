// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
"use client";

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "./utils.ts";

function Separator({ className, orientation = "horizontal", ...props }: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "ste:shrink-0 ste:bg-border ste:data-horizontal:h-px ste:data-horizontal:w-full ste:data-vertical:w-px ste:data-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
