// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
"use client";

import { useRef } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { usePrimitivesContainer, usePrimitivesActive, useDismissWithSurface } from "./provider.tsx";
import { cn } from "./utils.ts";

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip({ actionsRef, ...props }: TooltipPrimitive.Root.Props) {
  const localActions = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actions = actionsRef ?? localActions;
  useDismissWithSurface(actions);
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} actionsRef={actions} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  const container = usePrimitivesContainer();
  const active = usePrimitivesActive();
  if (!container || !active) return null;
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="ste:isolate ste:z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "ste:z-50 ste:inline-flex ste:w-fit ste:max-w-xs ste:origin-(--transform-origin) ste:items-center ste:gap-1.5 ste:rounded-xl ste:bg-foreground ste:px-3 ste:py-1.5 ste:text-xs ste:text-background ste:has-data-[slot=kbd]:pr-1.5 ste:data-[side=bottom]:slide-in-from-top-2 ste:data-[side=inline-end]:slide-in-from-left-2 ste:data-[side=inline-start]:slide-in-from-right-2 ste:data-[side=left]:slide-in-from-right-2 ste:data-[side=right]:slide-in-from-left-2 ste:data-[side=top]:slide-in-from-bottom-2 ste:**:data-[slot=kbd]:relative ste:**:data-[slot=kbd]:isolate ste:**:data-[slot=kbd]:z-50 ste:**:data-[slot=kbd]:rounded-lg ste:data-[state=delayed-open]:animate-in ste:data-[state=delayed-open]:fade-in-0 ste:data-[state=delayed-open]:zoom-in-95 ste:data-open:animate-in ste:data-open:fade-in-0 ste:data-open:zoom-in-95 ste:data-closed:animate-out ste:data-closed:fade-out-0 ste:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="ste:z-50 ste:size-2.5 ste:translate-y-[calc(-50%-2px)] ste:rotate-45 ste:rounded-[2px] ste:bg-foreground ste:fill-foreground ste:data-[side=bottom]:top-1 ste:data-[side=inline-end]:top-1/2! ste:data-[side=inline-end]:-left-1 ste:data-[side=inline-end]:translate-x-[1.5px] ste:data-[side=inline-end]:-translate-y-1/2 ste:data-[side=inline-start]:top-1/2! ste:data-[side=inline-start]:-right-1 ste:data-[side=inline-start]:translate-x-[-1.5px] ste:data-[side=inline-start]:-translate-y-1/2 ste:data-[side=left]:top-1/2! ste:data-[side=left]:-right-1 ste:data-[side=left]:translate-x-[-1.5px] ste:data-[side=left]:-translate-y-1/2 ste:data-[side=right]:top-1/2! ste:data-[side=right]:-left-1 ste:data-[side=right]:translate-x-[1.5px] ste:data-[side=right]:-translate-y-1/2 ste:data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
