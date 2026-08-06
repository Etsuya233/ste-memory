import { CircleAlert, Play } from "lucide-react";
import type { FormEvent } from "react";
import { Button, Field, TextInput } from "../ui.tsx";

interface FillTaskSubmitFormProps {
  readonly messageCount: number;
  readonly from: number;
  readonly to: number;
  readonly blockSize: number;
  readonly busy: boolean;
  /** 已有任务运行中：提交被禁用（服务端也会 409）。 */
  readonly blocked: boolean;
  readonly onFromChange: (value: number) => void;
  readonly onToChange: (value: number) => void;
  readonly onBlockSizeChange: (value: number) => void;
  readonly onSubmit: () => void;
}

/**
 * 填表任务提交表单（ticket 13）：消息闭区间 [from, to] + 分块大小。
 * 纯受控组件，范围校验只在界面层提示，服务端仍会复核。
 */
export function FillTaskSubmitForm({
  messageCount,
  from,
  to,
  blockSize,
  busy,
  blocked,
  onFromChange,
  onToChange,
  onBlockSizeChange,
  onSubmit,
}: FillTaskSubmitFormProps) {
  const rangeInvalid = from < 1 || to < from || to > messageCount;
  return (
    <form
      className="fill-task-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="fill-task-grid">
        <Field label="消息范围" hint={`共 ${messageCount} 条`} htmlFor="fill-from">
          <div className="fill-task-range">
            <TextInput
              id="fill-from"
              type="number"
              min={1}
              max={messageCount}
              value={Number.isFinite(from) ? from : ""}
              onChange={(event) => onFromChange(event.target.valueAsNumber)}
              aria-label="起始消息"
            />
            <i>至</i>
            <TextInput
              id="fill-to"
              type="number"
              min={1}
              max={messageCount}
              value={Number.isFinite(to) ? to : ""}
              onChange={(event) => onToChange(event.target.valueAsNumber)}
              aria-label="结束消息"
            />
          </div>
        </Field>
        <Field label="分块大小" hint="每条消息单独写入" htmlFor="fill-block">
          <TextInput
            id="fill-block"
            type="number"
            min={1}
            value={Number.isFinite(blockSize) ? blockSize : ""}
            onChange={(event) => onBlockSizeChange(event.target.valueAsNumber)}
            aria-label="分块大小"
          />
        </Field>
        <Field label="提交任务" hint={blocked ? "已有任务运行中" : undefined} htmlFor="fill-submit">
          <Button
            className="fill-task-submit"
            variant="primary"
            type="submit"
            block
            icon={<Play size={14} />}
            disabled={busy || blocked || rangeInvalid}
          >
            开始填表
          </Button>
        </Field>
      </div>
      {rangeInvalid ? (
        <p className="fill-task-hint">
          <CircleAlert size={12} /> 范围需在 [1, {messageCount}] 内
        </p>
      ) : null}
    </form>
  );
}
