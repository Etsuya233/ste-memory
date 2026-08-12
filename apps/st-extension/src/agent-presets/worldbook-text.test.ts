/**
 * 世界书扫描（ADR 0007）：把合并剧情文本（buildMergedStoryText 在
 * fill-tasks/fill-task-block.ts）包成单条消息交给 ST 自己的扫描器——
 * dry run 强制；旧版 ST 无 getWorldInfoPrompt → 空串降级。
 */
import { describe, expect, it, vi } from "vitest";
import { scanWorldbookText } from "./worldbook-text.ts";

describe("scanWorldbookText", () => {
  it("把合并文本包成单条消息、dry run 调用 ST 扫描，返回激活条目原文", async () => {
    const scan = vi.fn(async () => ({ worldInfoString: "条目内容" }));
    const text = await scanWorldbookText(
      { maxContext: 8192, getWorldInfoPrompt: scan },
      "爱丽丝：你好",
    );
    expect(text).toBe("条目内容");
    expect(scan).toHaveBeenCalledWith(["爱丽丝：你好"], 8192, true);
  });

  it("旧版 ST 无 getWorldInfoPrompt → 空串（版本守卫，不抛错）", async () => {
    expect(await scanWorldbookText({ maxContext: 8192 }, "爱丽丝：你好")).toBe("");
  });

  it("扫描无激活条目（worldInfoString 为空）→ 空串", async () => {
    const scan = vi.fn(async () => ({ worldInfoString: "" }));
    expect(await scanWorldbookText({ maxContext: 8192, getWorldInfoPrompt: scan }, "剧情")).toBe(
      "",
    );
  });
});
