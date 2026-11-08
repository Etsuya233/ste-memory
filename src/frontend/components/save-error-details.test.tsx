import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SnapshotSaveNotice } from "./snapshot-save-notice.tsx";
import { SnapshotSyncControl } from "../pages/settings/snapshot-sync-control.tsx";
import type { ChatSnapshotSaveStatus } from "../../features/chat-mirror/chat-snapshot-persistence.ts";

const message =
  "核验失败\n目标对话：A\n首个差异：chat_metadata.steMemoryMirror.data.space.name\n应保存：新名称\n文件回读：旧名称";
const status = (operation: "replacement" | "force-sync"): ChatSnapshotSaveStatus => ({
  kind: "failed",
  identity: "A",
  operation,
  error: message,
  humanMsg: message,
});

describe("保存诊断展示", () => {
  it("候选保存失败在顶部完整显示差异，并提供复制及重试", () => {
    const html = renderToStaticMarkup(
      <SnapshotSaveNotice status={status("replacement")} available onRetry={async () => {}} />,
    );
    for (const text of [
      "chat_metadata.steMemoryMirror.data.space.name",
      "应保存：新名称",
      "文件回读：旧名称",
      "复制错误详情",
      "重试保存",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("whitespace-pre-wrap");
  });

  it("重新进入设置仍显示持久状态中的强制同步失败，不依赖本次按钮请求", () => {
    const html = renderToStaticMarkup(
      <SnapshotSyncControl status={status("force-sync")} available onSync={async () => {}} />,
    );
    expect(html).toContain("chat_metadata.steMemoryMirror.data.space.name");
    expect(html).toContain("复制错误详情");
  });
});
