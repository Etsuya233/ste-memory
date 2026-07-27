import { describe, expect, it } from "vitest";
import { parseSillyTavernJsonl } from "../src/source-store/jsonl-parser.ts";

describe("parseSillyTavernJsonl", () => {
  it("preserves metadata, content, stable source identity, and extra properties", () => {
    const parsed = parseSillyTavernJsonl(
      [
        JSON.stringify({ user_name: "User", character_name: "Character", chat_metadata: {} }),
        JSON.stringify({ name: "User", is_user: true, mes: "你好", send_date: 100 }),
        "not-json",
        JSON.stringify({ name: "Character", is_user: false, mes: "欢迎" }),
      ].join("\n"),
    );

    expect(parsed.metadata).toMatchObject({ user_name: "User", character_name: "Character" });
    expect(parsed.messages).toEqual([
      {
        source_type: "sillytavern_jsonl",
        source_id: 1,
        content: "你好",
        extraProps: { name: "User", is_user: true, send_date: 100, lineNumber: 2 },
      },
      {
        source_type: "sillytavern_jsonl",
        source_id: 2,
        content: "欢迎",
        extraProps: { name: "Character", is_user: false, lineNumber: 4 },
      },
    ]);
    expect(parsed.errors).toEqual([
      { lineNumber: 3, rawLine: "not-json", message: "该行不是有效的 JSON" },
    ]);
  });
});
