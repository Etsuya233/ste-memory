import {
  ChevronDown,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

/* ---------------------------------------------------------------------------
 * 轻量 UI 原语：统一按钮 / 表单控件 / 徽标 / 开关 / 可折叠区块。
 * 样式全部走 theme.css 令牌，组件内不写行内样式。
 * ------------------------------------------------------------------------- */

/* ---------- localStorage 持久化 ---------- */

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? defaultValue : (JSON.parse(raw) as T);
    } catch {
      return defaultValue;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 忽略配额等异常 */
    }
  }, [key, value]);
  return [value, setValue];
}

/* ---------- 按钮 ---------- */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "primary" | "secondary" | "danger" | "ghost";
  readonly size?: "md" | "sm";
  readonly icon?: ReactNode;
  readonly loading?: boolean;
  readonly block?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  loading = false,
  block = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = [
    "btn",
    `btn-${variant}`,
    size === "sm" ? "btn-sm" : "",
    block ? "btn-block" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? <LoaderCircle size={15} className="spinning" /> : icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly danger?: boolean;
}

export function IconButton({
  label,
  danger = false,
  className = "",
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn ${danger ? "danger" : ""} ${className}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ---------- 表单字段 ---------- */

interface FieldProps {
  readonly label: string;
  readonly htmlFor?: string;
  readonly required?: boolean;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly note?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Field({
  label,
  htmlFor,
  required = false,
  hint,
  error,
  note,
  children,
  className = "",
}: FieldProps) {
  return (
    <label className={`field ${className}`} htmlFor={htmlFor}>
      <span className="field-label-row">
        <span className="field-label">
          {label}
          {required ? <em className="req">必填</em> : null}
        </span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
      {children}
      {error ? <p className="field-error">{error}</p> : null}
      {note ? <p className="field-note">{note}</p> : null}
    </label>
  );
}

export function TextInput({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`control ${className}`} {...rest} />;
}

export function TextArea({
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`control ${className}`} {...rest} />;
}

export function Select({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`control ${className}`} {...rest}>
      {children}
    </select>
  );
}

/* ---------- 开关 ---------- */

interface SwitchProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly title?: string;
  readonly ariaLabel?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  id,
  title,
  ariaLabel,
}: SwitchProps) {
  const control = (
    <label className="switch" title={title}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span />
    </label>
  );
  if (!label) return control;
  return (
    <span className="switch-row">
      {control}
      <span>
        {label}
        {hint ? <small> {hint}</small> : null}
      </span>
    </span>
  );
}

/* ---------- 徽标 ---------- */

export type BadgeTone = "accent" | "neutral" | "warn" | "danger";

export function Badge({
  tone = "neutral",
  children,
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/* ---------- 分段控件 ---------- */

interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly disabled?: boolean;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? "active" : ""}
            disabled={option.disabled}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {Icon ? <Icon size={14} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- 可折叠区块 ---------- */

interface CollapsibleSectionProps {
  readonly title: string;
  readonly icon?: LucideIcon;
  readonly count?: ReactNode;
  readonly actions?: ReactNode;
  readonly storageKey: string;
  readonly defaultOpen?: boolean;
  readonly flexible?: boolean;
  readonly children: ReactNode;
}

export function CollapsibleSection({
  title,
  icon: Icon,
  count,
  actions,
  storageKey,
  defaultOpen = true,
  flexible = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = usePersistedState(storageKey, defaultOpen);
  return (
    <section className={`side-section ${flexible ? "flexible" : ""} ${open ? "" : "collapsed"}`}>
      <div className="side-section-header">
        <button
          type="button"
          className="side-section-title"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {Icon ? <Icon size={15} /> : null}
          <h3>{title}</h3>
          <ChevronDown
            size={14}
            style={{
              color: "var(--ink-4)",
              transform: open ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform 0.15s ease",
            }}
          />
        </button>
        <span className="side-section-count">{count}</span>
        {actions}
      </div>
      {open ? <div className="side-section-body">{children}</div> : null}
    </section>
  );
}
