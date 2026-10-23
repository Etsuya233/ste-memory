import { useRef, type ReactNode } from "react";

/** 受控页面切换：统一胶囊样式与方向键焦点导航。 */
export function Tabs<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly {
    readonly value: Value;
    readonly label: ReactNode;
    readonly panelId: string;
    readonly dataAction?: string;
    readonly dataAttributes?: Readonly<Record<`data-${string}`, string>>;
  }[];
  readonly onChange: (value: Value) => void;
  readonly className?: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className={`stm-tabs ${props.className ?? ""}`} role="tablist" aria-label={props.label}>
      {props.options.map((option, index) => (
        <button
          {...option.dataAttributes}
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="tab"
          aria-selected={props.value === option.value}
          aria-controls={option.panelId}
          tabIndex={props.value === option.value ? 0 : -1}
          data-action={option.dataAction}
          onClick={() => props.onChange(option.value)}
          onKeyDown={(event) => {
            let next: number;
            if (event.key === "ArrowRight") next = (index + 1) % props.options.length;
            else if (event.key === "ArrowLeft")
              next = (index - 1 + props.options.length) % props.options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = props.options.length - 1;
            else return;
            event.preventDefault();
            buttons.current[next]!.focus();
            props.onChange(props.options[next]!.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
