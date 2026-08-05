import { X } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { datetimeLocalToStored, storedToDatetimeLocal } from "./datetime-format.ts";

/**
 * datetime 字段的一体式输入：单个 datetime-local 原生控件 + 显式清空按钮。
 * 值与存储契约一致："YYYY-MM-DD HH:mm:ss"（见 datetime-format.ts）。
 *
 * 实现要点：
 * - 本地 draft 保存正在编辑的值，作为“是否有值”的唯一依据（决定清空按钮显隐）；
 * - 输入框值与 draft 单向派生，避免 React 受控输入把原生控件“锁死”；
 * - 空值提交 undefined，完整值经 datetimeLocalToStored 归一化后提交。
 *
 * onBlur 只在焦点真正离开整个控件（而不是在输入框/清空按钮之间移动）时触发，
 * 保证表格单元格内的“点击即编辑”流程可以完整录入时间。
 */

interface DateTimeInputProps {
  readonly id?: string;
  readonly value: string | undefined;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly ariaLabel?: string;
  readonly onBlur?: () => void;
  readonly onChange: (value: string | undefined) => void;
}

export function DateTimeInput({
  id,
  value,
  required,
  disabled,
  autoFocus,
  ariaLabel,
  onBlur,
  onChange,
}: DateTimeInputProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<string | undefined>(value);

  // 外部值变化（保存后回写、清空按钮等）时同步本地草稿
  useEffect(() => setDraft(value), [value]);

  function commit(next: string) {
    if (!next) {
      setDraft(undefined);
      onChange(undefined);
    } else {
      const stored = datetimeLocalToStored(next);
      setDraft(stored);
      onChange(stored);
    }
  }

  function clear() {
    setDraft(undefined);
    onChange(undefined);
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    const related = event.relatedTarget;
    if (related instanceof Node && rootRef.current?.contains(related)) return;
    onBlur?.();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  return (
    <div className="datetime-control" ref={rootRef}>
      <input
        id={id}
        type="datetime-local"
        step={60}
        value={draft ? storedToDatetimeLocal(draft) : ""}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        onBlur={handleBlur}
        onChange={(event) => commit(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {draft ? (
        <button
          type="button"
          className="datetime-clear"
          aria-label={ariaLabel ? `清空${ariaLabel}` : "清空"}
          tabIndex={-1}
          onClick={clear}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}
