// Adapted from shadcn/ui base-luma registry; preset beEgoEQi.
import * as React from "react";
import { cn } from "./utils.ts";

import { ChevronDownIcon } from "lucide-react";

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  size?: "sm" | "default";
  htmlSize?: number;
  selectClassName?: string;
};

function NativeSelect({
  className,
  size = "default",
  htmlSize,
  selectClassName,
  multiple,
  ...props
}: NativeSelectProps) {
  return (
    <div
      className={cn(
        "ste:group/native-select ste:relative ste:w-fit ste:has-[select:disabled]:opacity-50",
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        multiple={multiple}
        size={htmlSize}
        data-slot="native-select"
        data-size={size}
        className={cn(
          "ste:h-9 ste:w-full ste:min-w-0 ste:appearance-none ste:rounded-3xl ste:border ste:border-transparent ste:bg-input/50 ste:py-1 ste:pr-8 ste:pl-3 ste:text-sm ste:transition-[color,box-shadow,background-color] ste:outline-none ste:select-none ste:selection:bg-primary ste:selection:text-primary-foreground ste:placeholder:text-muted-foreground ste:focus-visible:border-ring ste:focus-visible:ring-3 ste:focus-visible:ring-ring/30 ste:disabled:pointer-events-none ste:disabled:cursor-not-allowed ste:aria-invalid:border-destructive ste:aria-invalid:ring-3 ste:aria-invalid:ring-destructive/20 ste:data-[size=sm]:h-8 ste:dark:aria-invalid:border-destructive/50 ste:dark:aria-invalid:ring-destructive/40",
          multiple && "ste:h-auto ste:min-h-24 ste:pr-3",
          selectClassName,
        )}
        {...props}
      />
      {!multiple && (
        <ChevronDownIcon
          className="ste:pointer-events-none ste:absolute ste:top-1/2 ste:right-2.5 ste:size-4 ste:-translate-y-1/2 ste:text-muted-foreground ste:select-none"
          aria-hidden="true"
          data-slot="native-select-icon"
        />
      )}
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("ste:bg-[Canvas] ste:text-[CanvasText]", className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("ste:bg-[Canvas] ste:text-[CanvasText]", className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
