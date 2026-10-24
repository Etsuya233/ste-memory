import type { ReactNode } from "react";

/**
 * 表单内分段选择：按钮组语义，选中态承担说明职责。
 * 选项数量少且互斥时优先于下拉框，用户不需要展开就能看到全部选择。
 */
export function Segmented<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: ReactNode }[];
  readonly disabled?: boolean;
  readonly onChange: (value: Value) => void;
  readonly className?: string;
}) {
  return (
    <div
      className={`stm-segmented${props.className ? ` ${props.className}` : ""}`}
      role="group"
      aria-label={props.label}
    >
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={props.value === option.value}
          disabled={props.disabled}
          onClick={() => {
            if (props.value !== option.value) props.onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
