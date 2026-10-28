// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { cn } from "./utils.ts";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn(
        "ste:flex ste:w-full ste:flex-col ste:overflow-hidden ste:rounded-2xl ste:border",
        className,
      )}
      {...props}
    />
  );
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("ste:not-last:border-b ste:data-open:bg-muted/50", className)}
      {...props}
    />
  );
}

function AccordionTrigger({ className, children, ...props }: AccordionPrimitive.Trigger.Props) {
  return (
    <AccordionPrimitive.Header className="ste:flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "ste:group/accordion-trigger ste:relative ste:flex ste:flex-1 ste:items-start ste:justify-between ste:gap-6 ste:border ste:border-transparent ste:p-4 ste:text-left ste:text-sm ste:font-medium ste:transition-all ste:outline-none ste:hover:underline ste:aria-disabled:pointer-events-none ste:aria-disabled:opacity-50 ste:**:data-[slot=accordion-trigger-icon]:ml-auto ste:**:data-[slot=accordion-trigger-icon]:size-4 ste:**:data-[slot=accordion-trigger-icon]:text-muted-foreground",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon
          data-slot="accordion-trigger-icon"
          className="ste:pointer-events-none ste:shrink-0 ste:group-aria-expanded/accordion-trigger:hidden"
        />
        <ChevronUpIcon
          data-slot="accordion-trigger-icon"
          className="ste:pointer-events-none ste:hidden ste:shrink-0 ste:group-aria-expanded/accordion-trigger:inline"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({ className, children, ...props }: AccordionPrimitive.Panel.Props) {
  return (
    <AccordionPrimitive.Panel
      data-slot="accordion-content"
      className="ste:overflow-hidden ste:px-4 ste:text-sm ste:data-open:animate-accordion-down ste:data-closed:animate-accordion-up"
      {...props}
    >
      <div
        className={cn(
          "ste:h-(--accordion-panel-height) ste:pt-0 ste:pb-4 ste:data-ending-style:h-0 ste:data-starting-style:h-0 ste:[&_a]:underline ste:[&_a]:underline-offset-3 ste:[&_a]:hover:text-foreground ste:[&_p:not(:last-child)]:mb-4",
          className,
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Panel>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
