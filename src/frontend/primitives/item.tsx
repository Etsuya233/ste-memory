// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

import { Separator } from "./separator.tsx";

function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="list"
      data-slot="item-group"
      className={cn(
        "ste:group/item-group ste:flex ste:w-full ste:flex-col ste:gap-4 ste:has-data-[size=sm]:gap-2.5 ste:has-data-[size=xs]:gap-2",
        className,
      )}
      {...props}
    />
  );
}

function ItemSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      orientation="horizontal"
      className={cn("ste:my-2", className)}
      {...props}
    />
  );
}

const itemVariants = cva(
  "ste:group/item ste:flex ste:w-full ste:flex-wrap ste:items-center ste:rounded-2xl ste:border ste:text-sm ste:transition-colors ste:duration-100 ste:outline-none ste:focus-visible:border-ring ste:focus-visible:ring-[3px] ste:focus-visible:ring-ring/50 ste:[a]:transition-colors ste:[a]:hover:bg-muted",
  {
    variants: {
      variant: {
        default: "ste:border-transparent",
        outline: "ste:border-border",
        muted: "ste:border-transparent ste:bg-muted/50",
      },
      size: {
        default: "ste:gap-3.5 ste:px-4 ste:py-3.5",
        sm: "ste:gap-3.5 ste:px-3.5 ste:py-3",
        xs: "ste:gap-2.5 ste:px-3 ste:py-2.5 ste:in-data-[slot=dropdown-menu-content]:p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Item({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ variant, size, className })),
      },
      props,
    ),
    render,
    state: {
      slot: "item",
      variant,
      size,
    },
  });
}

const itemMediaVariants = cva(
  "ste:flex ste:shrink-0 ste:items-center ste:justify-center ste:gap-2 ste:group-has-data-[slot=item-description]/item:translate-y-0.5 ste:group-has-data-[slot=item-description]/item:self-start ste:[&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "ste:bg-transparent",
        icon: "ste:[&_svg:not([class*='size-'])]:size-4",
        image:
          "ste:size-10 ste:overflow-hidden ste:rounded-xl ste:group-data-[size=sm]/item:size-8 ste:group-data-[size=xs]/item:size-6 ste:group-data-[size=xs]/item:rounded-lg ste:[&_img]:size-full ste:[&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn(
        "ste:flex ste:flex-1 ste:flex-col ste:gap-1 ste:group-data-[size=xs]/item:gap-0.5 ste:[&+[data-slot=item-content]]:flex-none",
        className,
      )}
      {...props}
    />
  );
}

function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn(
        "ste:line-clamp-1 ste:flex ste:w-fit ste:items-center ste:gap-2 ste:text-sm ste:leading-snug ste:font-medium ste:underline-offset-4",
        className,
      )}
      {...props}
    />
  );
}

function ItemDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="item-description"
      className={cn(
        "ste:line-clamp-2 ste:text-left ste:text-sm ste:font-normal ste:text-muted-foreground ste:[&>a]:underline ste:[&>a]:underline-offset-4 ste:[&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("ste:flex ste:items-center ste:gap-2", className)}
      {...props}
    />
  );
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(
        "ste:flex ste:basis-full ste:items-center ste:justify-between ste:gap-2",
        className,
      )}
      {...props}
    />
  );
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "ste:flex ste:basis-full ste:items-center ste:justify-between ste:gap-2",
        className,
      )}
      {...props}
    />
  );
}

export {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
  ItemHeader,
  ItemFooter,
};
