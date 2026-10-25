import type { ComponentProps, ReactNode } from "react";

/** 原生展开区统一标题、状态与内容布局，保留 details 的键盘和开合行为。 */
export function Disclosure({
  leading,
  title,
  meta,
  children,
  className = "",
  ...props
}: Omit<ComponentProps<"details">, "title"> & {
  readonly leading?: ReactNode;
  readonly title: string;
  readonly meta?: ReactNode;
}) {
  return (
    <details {...props} className={`ui-disclosure ${className}`}>
      <summary className="ui-disclosure-summary">
        {leading != null && (
          <span className="ui-disclosure-icon" aria-hidden="true">
            {leading}
          </span>
        )}
        <span className="ui-disclosure-title">{title}</span>
        {meta != null ? <span className="ui-disclosure-meta">{meta}</span> : null}
        <svg
          className="ui-disclosure-chevron"
          width="8"
          height="12"
          viewBox="0 0 8 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m2 2 4 4-4 4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="ui-disclosure-body">{children}</div>
    </details>
  );
}
