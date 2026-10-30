// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

function Tabs({ className, orientation = "horizontal", ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn("ste:group/tabs ste:flex ste:gap-2 ste:data-horizontal:flex-col", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "ste:group/tabs-list ste:inline-flex ste:w-fit ste:items-center ste:justify-center ste:rounded-full ste:p-1 ste:text-muted-foreground ste:group-data-horizontal/tabs:h-9 ste:group-data-vertical/tabs:h-fit ste:group-data-vertical/tabs:flex-col ste:group-data-vertical/tabs:rounded-2xl ste:data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "ste:bg-muted",
        line: "ste:gap-1 ste:bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "ste:relative ste:inline-flex ste:h-[calc(100%-1px)] ste:flex-1 ste:items-center ste:justify-center ste:gap-2 ste:rounded-full ste:border ste:border-transparent! ste:px-3 ste:py-1 ste:text-sm ste:font-medium ste:whitespace-nowrap ste:text-foreground/60 ste:transition-all ste:group-data-vertical/tabs:w-full ste:group-data-vertical/tabs:justify-start ste:group-data-vertical/tabs:rounded-2xl ste:group-data-vertical/tabs:px-3 ste:group-data-vertical/tabs:py-1.5 ste:hover:text-foreground ste:focus-visible:border-ring ste:focus-visible:ring-[3px] ste:focus-visible:ring-ring/50 ste:focus-visible:outline-1 ste:focus-visible:outline-ring ste:disabled:pointer-events-none ste:disabled:opacity-50 ste:has-data-[icon=inline-end]:pr-2 ste:has-data-[icon=inline-start]:pl-2 ste:aria-disabled:pointer-events-none ste:aria-disabled:opacity-50 ste:dark:text-muted-foreground ste:dark:hover:text-foreground ste:[&_svg]:pointer-events-none ste:[&_svg]:shrink-0 ste:[&_svg:not([class*='size-'])]:size-4",
        "ste:group-data-[variant=line]/tabs-list:bg-transparent ste:group-data-[variant=line]/tabs-list:data-active:bg-transparent ste:dark:group-data-[variant=line]/tabs-list:data-active:border-transparent ste:dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "ste:data-active:bg-background ste:data-active:text-foreground ste:dark:data-active:border-input ste:dark:data-active:bg-input/30 ste:dark:data-active:text-foreground",
        "ste:after:absolute ste:after:bg-foreground ste:after:opacity-0 ste:after:transition-opacity ste:group-data-horizontal/tabs:after:inset-x-0 ste:group-data-horizontal/tabs:after:bottom-[-5px] ste:group-data-horizontal/tabs:after:h-0.5 ste:group-data-vertical/tabs:after:inset-y-0 ste:group-data-vertical/tabs:after:-right-1 ste:group-data-vertical/tabs:after:w-0.5 ste:group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("ste:flex-1 ste:text-sm ste:outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
