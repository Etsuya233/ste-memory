// Adapted from the official shadcn base-luma registry.
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "ste:flex ste:w-full ste:min-w-0 ste:flex-1 ste:flex-col ste:items-center ste:justify-center ste:gap-4 ste:rounded-2xl ste:border-dashed ste:p-12 ste:text-center ste:text-balance",
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("ste:flex ste:max-w-sm ste:flex-col ste:items-center ste:gap-2", className)}
      {...props}
    />
  );
}

const emptyMediaVariants = cva(
  "ste:mb-2 ste:flex ste:shrink-0 ste:items-center ste:justify-center ste:[&_svg]:pointer-events-none ste:[&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "ste:flex ste:size-10 ste:shrink-0 ste:items-center ste:justify-center ste:rounded-xl ste:bg-muted ste:text-foreground ste:[&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn("cn-font-heading ste:text-lg ste:font-medium ste:tracking-tight", className)}
      {...props}
    />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "ste:text-sm/relaxed ste:text-muted-foreground ste:[&>a]:underline ste:[&>a]:underline-offset-4 ste:[&>a:hover]:text-primary",
        className,
      )}
      {...props}
    />
  );
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "ste:flex ste:w-full ste:max-w-sm ste:min-w-0 ste:flex-col ste:items-center ste:gap-4 ste:text-sm ste:text-balance",
        className,
      )}
      {...props}
    />
  );
}

export { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyContent, EmptyMedia };
