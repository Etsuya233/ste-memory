import { createElement, useId, type ComponentProps, type ReactNode } from "react";

type ListGroupProps =
  | (ComponentProps<"div"> & { readonly as?: "div" })
  | (ComponentProps<"ul"> & { readonly as: "ul" })
  | (ComponentProps<"ol"> & { readonly as: "ol" });

export function ListGroup({ as: tag = "div", className = "", ...attributes }: ListGroupProps) {
  return createElement(tag, { ...attributes, className: `ui-list-group ${className}` });
}

export function ListSection({
  title,
  description,
  children,
  className = "",
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const id = useId();
  return (
    <section className={`ui-list-section ${className}`} aria-labelledby={id}>
      <h3 className="ui-section-title" id={id}>
        {title}
      </h3>
      {children}
      {description != null && <p className="ui-section-description">{description}</p>}
    </section>
  );
}

interface RowContentProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}

function RowContent({ title, description, leading, trailing }: RowContentProps) {
  return (
    <>
      {leading != null && <span className="ui-row-leading">{leading}</span>}
      <span className="ui-row-content">
        <span className="ui-row-title">{title}</span>
        {description != null && <span className="ui-row-description">{description}</span>}
      </span>
      {trailing != null && <span className="ui-row-trailing">{trailing}</span>}
    </>
  );
}

/** An entire navigation row is one button. Independent actions belong beside it. */
export function NavigationRow({
  title,
  description,
  leading,
  trailing,
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "title" | "children"> & RowContentProps) {
  return (
    <button type="button" {...props} className={`ui-list-row ui-navigation-row ${className}`}>
      <RowContent title={title} description={description} leading={leading} trailing={trailing} />
      <svg
        className="ui-row-chevron"
        width="9"
        height="14"
        viewBox="0 0 9 14"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="m2 2 5 5-5 5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** Selection/action rows share layout without suggesting navigation. */
export function ActionRow({
  title,
  description,
  leading,
  trailing,
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "title" | "children"> & RowContentProps) {
  return (
    <button type="button" {...props} className={`ui-list-row ui-navigation-row ${className}`}>
      <RowContent title={title} description={description} leading={leading} trailing={trailing} />
    </button>
  );
}

/** A non-clickable row can safely contain a switch, select, or separate action. */
export function ListRow({
  title,
  description,
  leading,
  trailing,
  className = "",
  ...props
}: Omit<ComponentProps<"div">, "title" | "children"> & RowContentProps) {
  return (
    <div {...props} className={`ui-list-row ${className}`}>
      <RowContent title={title} description={description} leading={leading} trailing={trailing} />
    </div>
  );
}
