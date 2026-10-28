// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
  usePrimitivesContainer,
  usePrimitivesActive,
  useDismissWithSurface,
  canRestoreSurfaceFocus,
} from "./provider.tsx";
import { cn } from "./utils.ts";

function Popover({ actionsRef, ...props }: PopoverPrimitive.Root.Props) {
  const localActions = React.useRef<PopoverPrimitive.Root.Actions | null>(null);
  const actions = actionsRef ?? localActions;
  useDismissWithSurface(actions);
  return <PopoverPrimitive.Root data-slot="popover" {...props} actionsRef={actions} />;
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  finalFocus,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  const container = usePrimitivesContainer();
  const active = usePrimitivesActive();
  if (!container || !active) return null;
  return (
    <PopoverPrimitive.Portal data-slot="popover-portal" container={container}>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="ste:isolate ste:z-50 ste:outline-none"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          finalFocus={(interaction) => {
            if (!canRestoreSurfaceFocus(container)) return false;
            return typeof finalFocus === "function"
              ? finalFocus(interaction)
              : typeof finalFocus === "object"
                ? finalFocus.current
                : (finalFocus ?? true);
          }}
          className={cn(
            "ste:z-50 ste:flex ste:w-72 ste:origin-(--transform-origin) ste:flex-col ste:gap-4 ste:rounded-3xl ste:bg-popover ste:p-4 ste:text-sm ste:text-popover-foreground ste:shadow-lg ste:ring-1 ste:ring-foreground/5 ste:outline-hidden ste:duration-100 ste:dark:ring-foreground/10 ste:data-[side=bottom]:slide-in-from-top-2 ste:data-[side=inline-end]:slide-in-from-left-2 ste:data-[side=inline-start]:slide-in-from-right-2 ste:data-[side=left]:slide-in-from-right-2 ste:data-[side=right]:slide-in-from-left-2 ste:data-[side=top]:slide-in-from-bottom-2 ste:data-open:animate-in ste:data-open:fade-in-0 ste:data-open:zoom-in-95 ste:data-closed:animate-out ste:data-closed:fade-out-0 ste:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("ste:flex ste:flex-col ste:gap-1 ste:text-sm", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("ste:text-base ste:font-medium", className)}
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("ste:text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
