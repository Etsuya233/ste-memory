import { describe, expect, it } from "vitest";
import {
  MUTATE_TOOL_NAME,
  PROPOSAL_PREVIEW_TOOL_NAME,
  SUBMIT_PROPOSAL_TOOL_NAME,
} from "@ste-memory/core/memory/agent";
import { fakeModel, lastToolResult, scriptedStreamFn } from "./chat-stream-support.ts";
import { assistantMessage, textMessage, toolCallMessage } from "./chat-stream-support.ts";
import { createTestApplication } from "./test-application.ts";

const CHAT = [
  '{"name":"Alice","is_user":true,"mes":"*你好*，**世界**！【重要】今天天气不错。"}',
  '{"name":"Bob","is_user":false,"mes":"（点头）【提醒】明天记得买牛奶。"}',
  '{"name":"Alice","is_user":true,"mes":"普通消息，没有符号。"}',
].join("\n");

function multipart(boundary: string, name: string, file?: string): string {
  const parts = [`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n`];
  if (file !== undefined) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chat.jsonl"\r\nContent-Type: application/jsonl\r\n\r\n${file}\r\n`,
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return parts.join("");
}

describe("清洗规则 × 填表任务集成", () => {
  it("喂给 Agent 的是清洗后内容，原文存储不变", async () => {
    let seenPrompt = "";
    const streamFn = scriptedStreamFn((context) => {
      if (!seenPrompt) {
        seenPrompt = context.messages
          .filter((message) => message.role === "user")
          .map((message) => {
            if (typeof message.content === "string") return message.content;
            return message.content
              .map((part) => {
                const text = (part as { readonly text?: string }).text;
                return text ?? "";
              })
              .join("");
          })
          .join("\n");
      }
      if (!lastToolResult(context)) {
        return assistantMessage(
          [
            toolCallMessage("call-1", MUTATE_TOOL_NAME, {
              op: "create",
              table: "characters",
              patch: { name: "云烬" },
            }),
            toolCallMessage("call-2", PROPOSAL_PREVIEW_TOOL_NAME, {}),
            toolCallMessage("call-3", SUBMIT_PROPOSAL_TOOL_NAME, {}),
          ],
          "toolUse",
        );
      }
      return assistantMessage([textMessage("已提交")], "stop");
    });
    const app = await createTestApplication("ste-cleaning-fill-", "2026-07-30T01:02:03.000Z", {
      buildLlmPort: () => ({ streamFn, model: fakeModel() }),
    });
    try {
      const boundary = "cleaning-fill";
      const created = await app.server.inject({
        method: "POST",
        url: "/memory-spaces",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, "清洗测试", CHAT),
      });
      expect(created.statusCode).toBe(201);
      const spaceId = created.json().id as string;

      await app.server.inject({
        method: "POST",
        url: `/memory-spaces/${spaceId}/cleaning-rules`,
        payload: { name: "去符号", mode: "discard", pattern: "[*（）【】]", flags: "g" },
      });

      const response = await app.server.inject({
        method: "POST",
        url: `/memory-spaces/${spaceId}/fill-tasks`,
        payload: {
          from: 1,
          to: 3,
          blockSize: 3,
          config: { model: "test-model", apiKey: "test-key", baseUrl: "" },
        },
      });
      expect(response.statusCode).toBe(202);
      const runId = response.json().runId;

      const deadline = Date.now() + 5_000;
      let terminal: { readonly status: string } | undefined;
      while (Date.now() < deadline) {
        const row = await app.context.database
          .selectFrom("memory_fill_tasks")
          .select(["status"])
          .where("run_id", "=", runId)
          .executeTakeFirst();
        if (row && row.status !== "running") {
          terminal = row;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(terminal?.status).toBe("succeeded");

      // Agent 收到的是清洗后内容：无 * 无 【】，但保留了中文正文。
      expect(seenPrompt).toContain("世界");
      expect(seenPrompt).not.toContain("*");
      expect(seenPrompt).not.toContain("【");
      // 原文存储不变（raw 读取仍是原始符号）。
      const raw = await app.server.inject({
        method: "GET",
        url: `/memory-spaces/${spaceId}/messages?raw=1`,
      });
      expect((raw.json() as { content: string }[])[0]!.content).toContain("*你好*");
    } finally {
      await app.server.close();
    }
  });
});
