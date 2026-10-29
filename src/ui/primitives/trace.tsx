// Adapted from shadcn/ui base-luma registry; isolated for embedded hosts.
import * as React from "react";
import { cn } from "./utils.ts";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible.tsx";
import { ChevronRight } from "lucide-react";

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn(
        "ste:flex ste:w-full ste:min-w-0 ste:flex-col ste:gap-3 ste:*:has-[>[data-slot=trace-line]]:flex ste:*:has-[>[data-slot=trace-line]]:w-fit ste:*:has-[>[data-slot=trace-line]]:max-w-full ste:*:has-[>[data-slot=trace-line]]:min-w-0 ste:*:has-[>[data-slot=trace-line]]:rounded-lg ste:*:has-[>[data-slot=trace-line]]:text-left ste:*:has-[>[data-slot=trace-line]]:outline-none ste:*:has-[>[data-slot=trace-line]]:focus-visible:ring-3 ste:*:has-[>[data-slot=trace-line]]:focus-visible:ring-ring/30",
        className,
      )}
      {...props}
    />
  );
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending";
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "ste:flex ste:w-fit ste:max-w-full ste:min-w-0 ste:items-center ste:gap-2 ste:text-sm ste:text-muted-foreground ste:transition-colors ste:in-[a,button]:cursor-pointer ste:in-[a:hover,button:hover]:text-foreground ste:data-[status=error]:text-destructive ste:data-[status=error]:in-[a:hover,button:hover]:text-destructive ste:data-[status=pending]:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "ste:flex ste:size-4 ste:shrink-0 ste:items-center ste:justify-center ste:[&_svg]:pointer-events-none ste:[&_svg:not([class*='size-'])]:size-4 ste:[[data-slot=trace-title]~&]:-ml-1",
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-title"
      className={cn("ste:min-w-0 ste:wrap-break-word", className)}
      {...props}
    />
  );
}

function TraceDescription({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn("ste:shrink-0 ste:text-muted-foreground/70 ste:tabular-nums", className)}
      {...props}
    />
  );
}

function TraceCollapsible({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "open"> &
  (
    | { open?: undefined }
    | {
        open: boolean;
        onOpenChange: NonNullable<React.ComponentProps<typeof Collapsible>["onOpenChange"]>;
      }
  )) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn("ste:flex ste:w-full ste:min-w-0 ste:flex-col", className)}
      {...props}
    />
  );
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "ste:group/trace-collapsible-trigger ste:flex ste:w-fit ste:max-w-full ste:min-w-0 ste:cursor-pointer ste:items-center ste:gap-1 ste:rounded-lg ste:border-0 ste:bg-transparent ste:p-0 ste:text-left ste:text-muted-foreground ste:transition-colors ste:outline-none ste:hover:text-foreground ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:has-[[data-status=error]]:text-destructive",
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="ste:transition-transform ste:group-aria-expanded/trace-collapsible-trigger:rotate-90">
        <ChevronRight />
      </TraceIcon>
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="trace-collapsible-content"
      className="ste:h-(--collapsible-panel-height) ste:min-w-0 ste:overflow-hidden ste:transition-[height] ste:duration-200 ste:motion-reduce:transition-none ste:data-ending-style:h-0 ste:data-starting-style:h-0"
      {...props}
    >
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          "ste:mt-2.5 ste:mb-1 ste:ml-[calc(--spacing(2)-1px)] ste:min-w-0 ste:border-l ste:pr-1 ste:pl-4 ste:leading-relaxed ste:wrap-break-word ste:text-muted-foreground",
          className,
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
};
