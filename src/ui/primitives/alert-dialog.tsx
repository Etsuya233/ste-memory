// Adapted from the official shadcn base-luma registry.
"use client";

import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { cn } from "./utils.ts";

import { Button } from "./button.tsx";
import {
  usePrimitivesContainer,
  usePrimitivesActive,
  useDismissWithSurface,
  canRestoreSurfaceFocus,
} from "./provider.tsx";

function AlertDialog({ actionsRef, ...props }: AlertDialogPrimitive.Root.Props) {
  const localActions = React.useRef<AlertDialogPrimitive.Root.Actions | null>(null);
  const actions = actionsRef ?? localActions;
  useDismissWithSurface(actions);
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} actionsRef={actions} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: Omit<AlertDialogPrimitive.Portal.Props, "container">) {
  const container = usePrimitivesContainer();
  const active = usePrimitivesActive();
  if (!container || !active) return null;
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} container={container} />
  );
}

function AlertDialogOverlay({ className, ...props }: AlertDialogPrimitive.Backdrop.Props) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(
        "ste:fixed ste:inset-0 ste:isolate ste:z-50 ste:bg-black/30 ste:duration-100 ste:supports-backdrop-filter:backdrop-blur-sm ste:data-open:animate-in ste:data-open:fade-in-0 ste:data-closed:animate-out ste:data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  size = "default",
  finalFocus,
  ...props
}: AlertDialogPrimitive.Popup.Props & {
  size?: "default" | "sm";
}) {
  const container = usePrimitivesContainer();
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        data-size={size}
        finalFocus={(interaction) => {
          if (!canRestoreSurfaceFocus(container)) return false;
          return typeof finalFocus === "function"
            ? finalFocus(interaction)
            : typeof finalFocus === "object"
              ? finalFocus.current
              : (finalFocus ?? true);
        }}
        className={cn(
          "ste:group/alert-dialog-content ste:fixed ste:top-1/2 ste:left-1/2 ste:z-50 ste:grid ste:w-full ste:-translate-x-1/2 ste:-translate-y-1/2 ste:gap-6 ste:rounded-4xl ste:bg-popover ste:p-6 ste:text-popover-foreground ste:shadow-xl ste:ring-1 ste:ring-foreground/5 ste:duration-100 ste:outline-none ste:data-[size=default]:max-w-xs ste:data-[size=sm]:max-w-xs ste:data-[size=default]:sm:max-w-md ste:dark:ring-foreground/10 ste:data-open:animate-in ste:data-open:fade-in-0 ste:data-open:zoom-in-95 ste:data-closed:animate-out ste:data-closed:fade-out-0 ste:data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn(
        "ste:grid ste:grid-rows-[auto_1fr] ste:place-items-center ste:gap-1.5 ste:text-center ste:has-data-[slot=alert-dialog-media]:grid-rows-[auto_auto_1fr] ste:has-data-[slot=alert-dialog-media]:gap-x-6 ste:sm:group-data-[size=default]/alert-dialog-content:place-items-start ste:sm:group-data-[size=default]/alert-dialog-content:text-left ste:sm:group-data-[size=default]/alert-dialog-content:has-data-[slot=alert-dialog-media]:grid-rows-[auto_1fr]",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        "ste:flex ste:flex-col-reverse ste:gap-2 ste:group-data-[size=sm]/alert-dialog-content:grid ste:group-data-[size=sm]/alert-dialog-content:grid-cols-2 ste:sm:flex-row ste:sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-media"
      className={cn(
        "ste:mb-2 ste:inline-flex ste:size-16 ste:items-center ste:justify-center ste:rounded-full ste:bg-muted ste:sm:group-data-[size=default]/alert-dialog-content:row-span-2 ste:*:[svg:not([class*='size-'])]:size-8",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn(
        "cn-font-heading ste:text-lg ste:font-medium ste:sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        "ste:text-sm ste:text-balance ste:text-muted-foreground ste:md:text-pretty ste:*:[a]:underline ste:*:[a]:underline-offset-3 ste:*:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button data-slot="alert-dialog-action" className={cn(className)} {...props} />;
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: AlertDialogPrimitive.Close.Props &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(className)}
      render={<Button variant={variant} size={size} />}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
