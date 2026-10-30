// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  usePrimitivesContainer,
  usePrimitivesActive,
  useDismissWithSurface,
  canRestoreSurfaceFocus,
} from "./provider.tsx";
import { cn } from "./utils.ts";

import { CheckIcon, ChevronRightIcon } from "lucide-react";

function DropdownMenu({ actionsRef, ...props }: MenuPrimitive.Root.Props) {
  const localActions = React.useRef<MenuPrimitive.Root.Actions | null>(null);
  const actions = actionsRef ?? localActions;
  useDismissWithSurface(actions);
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} actionsRef={actions} />;
}

function DropdownMenuPortal({ ...props }: Omit<MenuPrimitive.Portal.Props, "container">) {
  const container = usePrimitivesContainer();
  const active = usePrimitivesActive();
  if (!container || !active) return null;
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} container={container} />;
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  finalFocus,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  const container = usePrimitivesContainer();
  const active = usePrimitivesActive();
  if (!container || !active) return null;
  return (
    <DropdownMenuPortal>
      <MenuPrimitive.Positioner
        className="ste:isolate ste:z-50 ste:outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          finalFocus={(interaction) => {
            if (!canRestoreSurfaceFocus(container)) return false;
            return typeof finalFocus === "function"
              ? finalFocus(interaction)
              : typeof finalFocus === "object"
                ? finalFocus.current
                : (finalFocus ?? true);
          }}
          className={cn(
            "cn-menu-target cn-menu-translucent ste:z-50 ste:max-h-(--available-height) ste:w-(--anchor-width) ste:min-w-48 ste:origin-(--transform-origin) ste:overflow-x-hidden ste:overflow-y-auto ste:rounded-3xl ste:bg-popover ste:p-1.5 ste:text-popover-foreground ste:shadow-lg ste:ring-1 ste:ring-foreground/5 ste:duration-100 ste:outline-none ste:data-[side=bottom]:slide-in-from-top-2 ste:data-[side=inline-end]:slide-in-from-left-2 ste:data-[side=inline-start]:slide-in-from-right-2 ste:data-[side=left]:slide-in-from-right-2 ste:data-[side=right]:slide-in-from-left-2 ste:data-[side=top]:slide-in-from-bottom-2 ste:dark:ring-foreground/10 ste:data-open:animate-in ste:data-open:fade-in-0 ste:data-open:zoom-in-95 ste:data-closed:animate-out ste:data-closed:overflow-hidden ste:data-closed:fade-out-0 ste:data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </DropdownMenuPortal>
  );
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "ste:px-3 ste:py-2.5 ste:text-xs ste:text-muted-foreground ste:data-inset:pl-9.5",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "ste:group/dropdown-menu-item ste:relative ste:flex ste:cursor-default ste:items-center ste:gap-2.5 ste:rounded-2xl ste:px-3 ste:py-2 ste:text-sm ste:font-medium ste:outline-hidden ste:select-none ste:focus:bg-accent ste:focus:text-accent-foreground ste:not-data-[variant=destructive]:focus:**:text-accent-foreground ste:data-inset:pl-9.5 ste:data-[variant=destructive]:text-destructive ste:data-[variant=destructive]:focus:bg-destructive/10 ste:data-[variant=destructive]:focus:text-destructive ste:dark:data-[variant=destructive]:focus:bg-destructive/20 ste:data-disabled:pointer-events-none ste:data-disabled:opacity-50 ste:[&_svg]:pointer-events-none ste:[&_svg]:shrink-0 ste:[&_svg:not([class*='size-'])]:size-4 ste:data-[variant=destructive]:*:[svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "ste:flex ste:cursor-default ste:items-center ste:gap-2 ste:rounded-2xl ste:px-3 ste:py-2 ste:text-sm ste:font-medium ste:outline-hidden ste:select-none ste:focus:bg-accent ste:focus:text-accent-foreground ste:not-data-[variant=destructive]:focus:**:text-accent-foreground ste:data-inset:pl-9.5 ste:data-popup-open:bg-accent ste:data-popup-open:text-accent-foreground ste:data-open:bg-accent ste:data-open:text-accent-foreground ste:[&_svg]:pointer-events-none ste:[&_svg]:shrink-0 ste:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="cn-rtl-flip ste:ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "cn-menu-target cn-menu-translucent ste:w-auto ste:min-w-36 ste:rounded-3xl ste:bg-popover ste:p-1.5 ste:text-popover-foreground ste:shadow-lg ste:ring-1 ste:ring-foreground/5 ste:duration-100 ste:data-[side=bottom]:slide-in-from-top-2 ste:data-[side=left]:slide-in-from-right-2 ste:data-[side=right]:slide-in-from-left-2 ste:data-[side=top]:slide-in-from-bottom-2 ste:dark:ring-foreground/10 ste:data-open:animate-in ste:data-open:fade-in-0 ste:data-open:zoom-in-95 ste:data-closed:animate-out ste:data-closed:fade-out-0 ste:data-closed:zoom-out-95",
        className,
      )}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "ste:relative ste:flex ste:cursor-default ste:items-center ste:gap-2.5 ste:rounded-2xl ste:py-2 ste:pr-8 ste:pl-3 ste:text-sm ste:font-medium ste:outline-hidden ste:select-none ste:focus:bg-accent ste:focus:text-accent-foreground ste:focus:**:text-accent-foreground ste:data-inset:pl-9.5 ste:data-disabled:pointer-events-none ste:data-disabled:opacity-50 ste:[&_svg]:pointer-events-none ste:[&_svg]:shrink-0 ste:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className="ste:pointer-events-none ste:absolute ste:right-2 ste:flex ste:items-center ste:justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "ste:relative ste:flex ste:cursor-default ste:items-center ste:gap-2.5 ste:rounded-2xl ste:py-2 ste:pr-8 ste:pl-3 ste:text-sm ste:font-medium ste:outline-hidden ste:select-none ste:focus:bg-accent ste:focus:text-accent-foreground ste:focus:**:text-accent-foreground ste:data-inset:pl-9.5 ste:data-disabled:pointer-events-none ste:data-disabled:opacity-50 ste:[&_svg]:pointer-events-none ste:[&_svg]:shrink-0 ste:[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span
        className="ste:pointer-events-none ste:absolute ste:right-2 ste:flex ste:items-center ste:justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("ste:-mx-1.5 ste:my-1.5 ste:h-px ste:bg-border/50", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ste:ml-auto ste:text-xs ste:tracking-widest ste:text-muted-foreground ste:group-focus/dropdown-menu-item:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
