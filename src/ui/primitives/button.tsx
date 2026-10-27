// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils.ts";

const buttonVariants = cva(
  "ste:group/button ste:inline-flex ste:shrink-0 ste:items-center ste:justify-center ste:rounded-4xl ste:border ste:border-transparent ste:bg-clip-padding ste:text-sm ste:font-medium ste:whitespace-nowrap ste:transition-all ste:outline-none ste:select-none ste:focus-visible:border-ring ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:active:not-aria-[haspopup]:translate-y-px ste:disabled:pointer-events-none ste:disabled:opacity-50 ste:aria-invalid:border-destructive ste:aria-invalid:ring-3 ste:aria-invalid:ring-destructive/20 ste:dark:aria-invalid:border-destructive/50 ste:dark:aria-invalid:ring-destructive/40 ste:[&_svg]:pointer-events-none ste:[&_svg]:shrink-0 ste:[&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "ste:bg-primary ste:text-primary-foreground ste:hover:bg-primary/80",
        outline:
          "ste:border-border ste:bg-background ste:hover:bg-muted ste:hover:text-foreground ste:aria-expanded:bg-muted ste:aria-expanded:text-foreground ste:dark:bg-transparent ste:dark:hover:bg-input/30",
        secondary:
          "ste:bg-secondary ste:text-secondary-foreground ste:hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] ste:aria-expanded:bg-secondary ste:aria-expanded:text-secondary-foreground",
        ghost:
          "ste:hover:bg-muted ste:hover:text-foreground ste:aria-expanded:bg-muted ste:aria-expanded:text-foreground ste:dark:hover:bg-muted/50",
        destructive:
          "ste:bg-destructive/10 ste:text-destructive ste:hover:bg-destructive/20 ste:focus-visible:border-destructive/40 ste:focus-visible:ring-destructive/20 ste:dark:bg-destructive/20 ste:dark:hover:bg-destructive/30 ste:dark:focus-visible:ring-destructive/40",
        link: "ste:text-primary ste:underline-offset-4 ste:hover:underline",
      },
      size: {
        default:
          "ste:h-9 ste:gap-1.5 ste:px-3 ste:has-data-[icon=inline-end]:pr-2.5 ste:has-data-[icon=inline-start]:pl-2.5",
        xs: "ste:h-6 ste:gap-1 ste:px-2.5 ste:text-xs ste:has-data-[icon=inline-end]:pr-2 ste:has-data-[icon=inline-start]:pl-2 ste:[&_svg:not([class*='size-'])]:size-3",
        sm: "ste:h-8 ste:gap-1 ste:px-3 ste:has-data-[icon=inline-end]:pr-2 ste:has-data-[icon=inline-start]:pl-2",
        lg: "ste:h-10 ste:gap-1.5 ste:px-4 ste:has-data-[icon=inline-end]:pr-3 ste:has-data-[icon=inline-start]:pl-3",
        icon: "ste:size-9",
        "icon-xs": "ste:size-6 ste:[&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "ste:size-8",
        "icon-lg": "ste:size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
