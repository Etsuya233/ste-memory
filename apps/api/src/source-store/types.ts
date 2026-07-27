export const SILLY_TAVERN_SOURCE_TYPE = "sillytavern_jsonl" as const;

export interface SourceMessage {
  readonly source_type: typeof SILLY_TAVERN_SOURCE_TYPE;
  readonly source_id: number;
  readonly content: string;
  readonly extraProps: Readonly<Record<string, unknown>>;
}

export interface SourceParseError {
  readonly lineNumber: number;
  readonly rawLine: string;
  readonly message: string;
}

export interface ParsedChat {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly messages: readonly SourceMessage[];
  readonly errors: readonly SourceParseError[];
}

export interface SourceChatSummary {
  readonly messageCount: number;
  readonly errorCount: number;
}
