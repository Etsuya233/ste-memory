import { X } from "lucide-react";
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

/**
 * datetime 字段的分体输入：日期 + 时间两个原生控件并排。
 * 相比 datetime-local，在窄容器（表格单元格、表单两栏）中不会挤压掉时间段，
 * 且“清空”按钮显式可见，避免只能靠键盘删除的问题。
 * 值与存储契约一致："YYYY-MM-DD HH:mm:ss"（见 datetime-format.ts）。
 *
 * 实现要点：
 * - 本地 draft 保存正在编辑的值，每次按键都更新本地状态，
 *   避免 React 受控输入的值追踪把原生 date/time 控件“锁死”（按键不生效）；
 * - 只把“完整值”（日期+时间）提交给上层；只填日期时按 00:00:00 补齐；
 *   只填时间时不提交（没有日期的时间没有意义）。
 *
 * onBlur 只在焦点真正离开整个控件（而不是在日期/时间/清空之间移动）时触发，
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
  const [date, time] = splitStored(draft);

  // 外部值变化（保存后回写、清空按钮等）时同步本地草稿
  useEffect(() => setDraft(value), [value]);

  function commit(nextDate: string, nextTime: string) {
    if (!nextDate && !nextTime) {
      setDraft(undefined);
      onChange(undefined);
    } else if (nextDate && nextTime) {
      const full = `${nextDate} ${nextTime.length === 5 ? `${nextTime}:00` : nextTime}`;
      setDraft(full);
      onChange(full);
    } else if (nextDate) {
      // 只填日期：按 00:00:00 补齐（服务端 datetime 契约要求完整值）
      const full = `${nextDate} 00:00:00`;
      setDraft(full);
      onChange(full);
    } else {
      // 只填时间：没有日期的时刻没有意义，保留在本地草稿但不提交
      setDraft(nextTime);
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
        type="date"
        value={date}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel ? `${ariaLabel}（日期）` : undefined}
        onBlur={handleBlur}
        onChange={(event) => commit(event.target.value, time)}
        onKeyDown={onKeyDown}
      />
      <input
        id={id ? `${id}-time` : undefined}
        type="time"
        step={60}
        value={time}
        required={required}
        disabled={disabled}
        aria-label={ariaLabel ? `${ariaLabel}（时间）` : undefined}
        onBlur={handleBlur}
        onChange={(event) => commit(date, event.target.value)}
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

function splitStored(value: string | undefined): [string, string] {
  if (!value) return ["", ""];
  const [datePart = "", timePart = ""] = value.split(" ");
  return [datePart, timePart.slice(0, 5)];
}
