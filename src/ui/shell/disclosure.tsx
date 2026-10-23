import type { ComponentProps, ReactNode } from "react";

/** 原生展开区统一标题、状态与内容布局，保留 details 的键盘和开合行为。 */
export function Disclosure({
  icon,
  title,
  meta,
  children,
  className = "",
  ...props
}: Omit<ComponentProps<"details">, "title"> & {
  readonly icon: string;
  readonly title: string;
  readonly meta?: ReactNode;
}) {
  return (
    <details {...props} className={`stm-disclosure ${className}`}>
      <summary className="stm-disclosure-summary">
        <i className={`fa-solid ${icon} stm-disclosure-icon`} aria-hidden="true" />
        <span className="stm-disclosure-title">{title}</span>
        {meta != null ? <span className="stm-disclosure-meta">{meta}</span> : null}
        <i className="fa-solid fa-chevron-right stm-disclosure-chevron" aria-hidden="true" />
      </summary>
      <div className="stm-disclosure-body">{children}</div>
    </details>
  );
}
