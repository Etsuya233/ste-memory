import { applyCleaningRule, type CleaningRule } from "../cleaning/cleaning-rules.ts";

export interface MemoryChatMessage {
  readonly floor: number;
  readonly name: string;
  readonly role: "user" | "assistant" | "narrator";
  readonly content: string;
}

export interface RecentChatSnapshot {
  readonly chatIdentity: string;
  readonly messages: readonly MemoryChatMessage[];
  readonly cleaning: {
    readonly enabled: boolean;
    readonly ruleId: string | null;
    readonly ruleName: string | null;
  };
}

export interface MemoryChatApi {
  readonly version: 1;
  readRecent(request: {
    readonly chatIdentity: string;
    readonly count: number;
  }): Promise<RecentChatSnapshot>;
}

/** Reads the selected window once; cleaned-away messages never pull older floors into it. */
export function createMemoryChatApi(source: {
  getChatIdentity(): string | null;
  readRecentMessages(count: number): readonly MemoryChatMessage[];
  readCleaningRule(): CleaningRule | undefined;
}): MemoryChatApi {
  return {
    version: 1,
    async readRecent(request) {
      if (!request.chatIdentity || source.getChatIdentity() !== request.chatIdentity)
        throw new Error("当前对话已变化，请重新读取聊天");
      if (!Number.isSafeInteger(request.count) || request.count <= 0)
        throw new Error("最近聊天条数须为正整数");
      const rule = source.readCleaningRule();
      const messages = source.readRecentMessages(request.count).flatMap((message) => {
        const content =
          message.role === "assistant" && rule
            ? applyCleaningRule(message.content, rule)
            : message.content;
        return content.trim() ? [Object.freeze({ ...message, content })] : [];
      });
      if (source.getChatIdentity() !== request.chatIdentity)
        throw new Error("读取期间对话已变化，请重新读取聊天");
      return Object.freeze({
        chatIdentity: request.chatIdentity,
        messages: Object.freeze(messages),
        cleaning: Object.freeze({
          enabled: rule?.enabled === true,
          ruleId: rule?.id ?? null,
          ruleName: rule?.name ?? null,
        }),
      });
    },
  };
}
