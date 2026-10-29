import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../ui/primitives/utils.ts";

/** Bordered page grouping used by settings, tasks and other detail surfaces. */
export function PageSection({
  title,
  meta,
  action,
  bodyClassName,
  children,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="ste:overflow-hidden ste:rounded-xl ste:border ste:border-border" {...props}>
      <header className="ste:flex ste:flex-wrap ste:items-center ste:justify-between ste:gap-2 ste:border-b ste:border-border ste:px-4 ste:py-2.5">
        <h2 className="ste:text-sm ste:font-semibold">{title}</h2>
        {meta || action ? (
          <div className="ste:flex ste:flex-wrap ste:items-center ste:justify-end ste:gap-2">
            {meta}
            {action}
          </div>
        ) : null}
      </header>
      <div className={cn("ste:px-4 ste:py-3", bodyClassName)}>{children}</div>
    </section>
  );
}
