// Adapted from shadcn/ui base-luma registry; isolated for embedded hosts.
import * as React from "react";
import { cn } from "./utils.ts";

function MessageGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-group"
      className={cn("ste:flex ste:min-w-0 ste:flex-col ste:gap-2", className)}
      {...props}
    />
  );
}

function Message({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        "ste:group/message ste:relative ste:flex ste:w-full ste:min-w-0 ste:gap-2 ste:text-sm ste:data-[align=end]:flex-row-reverse",
        className,
      )}
      {...props}
    />
  );
}

function MessageAvatar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-avatar"
      className={cn(
        "ste:flex ste:w-fit ste:min-w-8 ste:shrink-0 ste:items-center ste:justify-center ste:self-end ste:overflow-hidden ste:rounded-full ste:bg-muted ste:group-has-data-[slot=message-footer]/message:-translate-y-8",
        className,
      )}
      {...props}
    />
  );
}

function MessageContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "ste:flex ste:w-full ste:min-w-0 ste:flex-col ste:gap-2.5 ste:wrap-break-word ste:group-data-[align=end]/message:*:data-slot:self-end",
        className,
      )}
      {...props}
    />
  );
}

function MessageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn(
        "ste:flex ste:max-w-full ste:min-w-0 ste:items-center ste:px-3.5 ste:text-xs ste:font-medium ste:text-muted-foreground ste:group-has-data-[variant=ghost]/message:px-0",
        className,
      )}
      {...props}
    />
  );
}

function MessageFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        "ste:flex ste:max-w-full ste:min-w-0 ste:items-center ste:px-3.5 ste:text-xs ste:font-medium ste:text-muted-foreground ste:group-has-data-[variant=ghost]/message:px-0 ste:group-data-[align=end]/message:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export { MessageGroup, Message, MessageAvatar, MessageContent, MessageFooter, MessageHeader };
