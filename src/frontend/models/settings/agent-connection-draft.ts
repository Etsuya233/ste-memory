import {
  connectionHeaderError,
  type AgentConnection,
} from "../../../features/settings/agent-connections.ts";

export interface ConnectionHeaderRow {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

export interface AgentConnectionDraft extends Omit<AgentConnection, "customHeaders"> {
  readonly headerRows: readonly ConnectionHeaderRow[];
}

export function createConnectionDraft(
  connection: AgentConnection,
  createId: () => string,
): AgentConnectionDraft {
  const { customHeaders, ...fields } = connection;
  return {
    ...fields,
    headerRows: Object.entries(customHeaders ?? {}).map(([name, value]) => ({
      id: createId(),
      name,
      value,
    })),
  };
}

/** 保留重复及未完成的行用于脏状态比较，校验通过后才转换为持久化配置。 */
export function connectionFromDraft(draft: AgentConnectionDraft): AgentConnection {
  const { headerRows, ...fields } = draft;
  const entries = headerRows.map(({ name, value }) => [name, value] as const);
  const error = connectionHeaderError(entries);
  if (error) throw new Error(error);
  return { ...fields, customHeaders: Object.fromEntries(entries) };
}
