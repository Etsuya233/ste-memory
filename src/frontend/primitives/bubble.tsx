// Adapted from shadcn/ui base-luma registry; isolated for embedded hosts.
import * as React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

function BubbleGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-group"
      className={cn("ste:flex ste:min-w-0 ste:flex-col ste:gap-2", className)}
      {...props}
    />
  );
}

const bubbleVariants = cva(
  "ste:group/bubble ste:relative ste:flex ste:w-fit ste:max-w-[80%] ste:min-w-0 ste:flex-col ste:gap-1 ste:group-data-[align=end]/message:self-end ste:data-[align=end]:self-end ste:data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        default:
          "ste:*:data-[slot=bubble-content]:bg-primary ste:*:data-[slot=bubble-content]:text-primary-foreground ste:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-primary/80",
        secondary:
          "ste:*:data-[slot=bubble-content]:bg-secondary ste:*:data-[slot=bubble-content]:text-secondary-foreground ste:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        muted:
          "ste:*:data-[slot=bubble-content]:bg-muted ste:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]",
        tinted:
          "ste:*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)] ste:*:data-[slot=bubble-content]:text-foreground ste:dark:*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.3_calc(c*0.4)_h)] ste:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.88_calc(c*0.5)_h)] ste:dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.35_calc(c*0.5)_h)]",
        outline:
          "ste:*:data-[slot=bubble-content]:border-border ste:*:data-[slot=bubble-content]:bg-background ste:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted ste:[&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground ste:dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-input/30",
        ghost:
          "ste:border-none ste:*:data-[slot=bubble-content]:rounded-none ste:*:data-[slot=bubble-content]:bg-transparent ste:*:data-[slot=bubble-content]:p-0 ste:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted ste:[&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground ste:dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted/50",
        destructive:
          "ste:*:data-[slot=bubble-content]:bg-destructive/10 ste:*:data-[slot=bubble-content]:text-destructive ste:dark:*:data-[slot=bubble-content]:bg-destructive/20 ste:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/20 ste:dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Bubble({
  variant = "default",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & {
    align?: "start" | "end";
  }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  );
}

function BubbleContent({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "ste:w-fit ste:max-w-full ste:min-w-0 ste:overflow-hidden ste:rounded-3xl ste:border ste:border-transparent ste:px-3.5 ste:py-2.5 ste:text-sm ste:leading-relaxed ste:wrap-break-word ste:group-data-[align=end]/bubble:self-end ste:[button]:text-left ste:[button,a]:transition-colors ste:[button,a]:outline-none ste:[button,a]:focus-visible:border-ring ste:[button,a]:focus-visible:ring-3 ste:[button,a]:focus-visible:ring-ring/30",
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "bubble-content",
    },
  });
}

const bubbleReactionsVariants = cva(
  "ste:absolute ste:z-10 ste:flex ste:w-fit ste:shrink-0 ste:items-center ste:justify-center ste:gap-1 ste:rounded-full ste:bg-muted ste:px-1.5 ste:py-0.5 ste:text-sm ste:ring-3 ste:ring-card ste:has-[button]:p-0",
  {
    variants: {
      side: {
        top: "ste:top-0 ste:-translate-y-3/4",
        bottom: "ste:bottom-0 ste:translate-y-3/4",
      },
      align: {
        start: "left-3",
        end: "right-3",
      },
    },
    defaultVariants: {
      side: "bottom",
      align: "end",
    },
  },
);

function BubbleReactions({
  side = "bottom",
  align = "end",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  align?: "start" | "end";
  side?: "top" | "bottom";
}) {
  return (
    <div
      data-slot="bubble-reactions"
      data-align={align}
      data-side={side}
      className={cn(bubbleReactionsVariants({ side, align }), className)}
      {...props}
    />
  );
}

export { BubbleGroup, Bubble, BubbleContent, BubbleReactions };
