// Adapted from the official shadcn base-luma registry.
import { cn } from "./utils.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("ste:animate-pulse ste:rounded-2xl ste:bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
