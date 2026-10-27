// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import * as React from "react";
import { cn } from "./utils.ts";

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "ste:group/card ste:flex ste:flex-col ste:gap-(--card-spacing) ste:overflow-hidden ste:rounded-4xl ste:bg-card ste:py-(--card-spacing) ste:text-sm ste:text-card-foreground ste:shadow-md ste:ring-1 ste:ring-foreground/5 ste:[--card-spacing:--spacing(6)] ste:has-[>img:first-child]:pt-0 ste:data-[size=sm]:[--card-spacing:--spacing(4)] ste:dark:ring-foreground/10 ste:*:[img:first-child]:rounded-t-4xl ste:*:[img:last-child]:rounded-b-4xl",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "ste:group/card-header ste:@container/card-header ste:grid ste:auto-rows-min ste:items-start ste:gap-1.5 ste:rounded-t-4xl ste:px-(--card-spacing) ste:has-data-[slot=card-action]:grid-cols-[1fr_auto] ste:has-data-[slot=card-description]:grid-rows-[auto_auto] ste:[.border-b]:pb-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("cn-font-heading ste:text-base ste:font-medium", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("ste:text-sm ste:text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "ste:col-start-2 ste:row-span-2 ste:row-start-1 ste:self-start ste:justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-content" className={cn("ste:px-(--card-spacing)", className)} {...props} />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "ste:flex ste:items-center ste:rounded-b-4xl ste:px-(--card-spacing) ste:[.border-t]:pt-(--card-spacing)",
        className,
      )}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
