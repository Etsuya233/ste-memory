// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

const badgeVariants = cva(
  "ste:group/badge ste:inline-flex ste:h-5 ste:w-fit ste:shrink-0 ste:items-center ste:justify-center ste:gap-1 ste:overflow-hidden ste:rounded-3xl ste:border ste:border-transparent ste:px-2 ste:py-0.5 ste:text-xs ste:font-medium ste:whitespace-nowrap ste:transition-all ste:focus-visible:border-ring ste:focus-visible:ring-[3px] ste:focus-visible:ring-ring/50 ste:has-data-[icon=inline-end]:pr-1.5 ste:has-data-[icon=inline-start]:pl-1.5 ste:aria-invalid:border-destructive ste:aria-invalid:ring-destructive/20 ste:dark:aria-invalid:ring-destructive/40 ste:[&>svg]:pointer-events-none ste:[&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "ste:bg-primary ste:text-primary-foreground ste:[a]:hover:bg-primary/80",
        secondary: "ste:bg-secondary ste:text-secondary-foreground ste:[a]:hover:bg-secondary/80",
        destructive:
          "ste:bg-destructive/10 ste:text-destructive ste:focus-visible:ring-destructive/20 ste:dark:bg-destructive/20 ste:dark:focus-visible:ring-destructive/40 ste:[a]:hover:bg-destructive/20",
        outline:
          "ste:border-border ste:text-foreground ste:[a]:hover:bg-muted ste:[a]:hover:text-muted-foreground",
        ghost: "ste:hover:bg-muted ste:hover:text-muted-foreground ste:dark:hover:bg-muted/50",
        link: "ste:text-primary ste:underline-offset-4 ste:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
