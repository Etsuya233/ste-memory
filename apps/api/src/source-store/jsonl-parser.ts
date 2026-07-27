import {
  SILLY_TAVERN_SOURCE_TYPE,
  type ParsedChat,
  type SourceMessage,
  type SourceParseError,
} from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatHeader(value: Record<string, unknown>): boolean {
  return (
    "chat_metadata" in value ||
    (typeof value.user_name === "string" && typeof value.character_name === "string")
  );
}

export function parseSillyTavernJsonl(content: string): ParsedChat {
  const messages: SourceMessage[] = [];
  const errors: SourceParseError[] = [];
  let metadata: Readonly<Record<string, unknown>> = {};

  for (const [index, rawLine] of content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/u)
    .entries()) {
    const lineNumber = index + 1;
    if (rawLine.trim().length === 0) continue;

    let value: unknown;
    try {
      value = JSON.parse(rawLine);
    } catch {
      errors.push({ lineNumber, rawLine, message: "该行不是有效的 JSON" });
      continue;
    }

    if (!isObject(value)) {
      errors.push({ lineNumber, rawLine, message: "该行必须是 JSON 对象" });
      continue;
    }
    if (messages.length === 0 && Object.keys(metadata).length === 0 && isChatHeader(value)) {
      metadata = value;
      continue;
    }
    if (typeof value.mes !== "string") {
      errors.push({ lineNumber, rawLine, message: "消息缺少字符串类型的 mes 字段" });
      continue;
    }

    const { mes, ...properties } = value;
    messages.push({
      source_type: SILLY_TAVERN_SOURCE_TYPE,
      source_id: messages.length + 1,
      content: mes,
      extraProps: { ...properties, lineNumber },
    });
  }

  return { metadata, messages, errors };
}
