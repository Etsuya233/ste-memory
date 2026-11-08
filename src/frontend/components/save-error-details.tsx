import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { copyText } from "./copy-text.ts";

/** 保存错误原文就地可读、可复制；沿用 HTTP 页面可用的剪贴板能力。 */
export function SaveErrorDetails({ message }: { message: string }) {
  const [copied, setCopied] = useState<{ message: string; error?: string } | null>(null);
  async function copy() {
    try {
      await copyText(message);
      setCopied({ message });
    } catch (error) {
      setCopied({ message, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const current = copied?.message === message ? copied : null;
  return (
    <div className="ste:min-w-0 ste:flex-1" data-testid="save-error-details">
      <p
        className="ste:whitespace-pre-wrap ste:break-words ste:[overflow-wrap:anywhere]"
        data-testid="save-error-message"
      >
        {message}
      </p>
      <Button variant="link" size="xs" onClick={() => void copy()}>
        {current && !current.error ? "已复制错误详情" : "复制错误详情"}
      </Button>
      {current?.error && <p role="alert">复制失败：{current.error}</p>}
    </div>
  );
}
