/**
 * 处理块适配（ticket 13）：把来源消息块翻译成 Agent 的输入形态。
 *
 * 行为基准 = apps/api `application/fill-tasks/fill-task-block.ts`（浏览器侧副本，
 * 两个应用互不依赖，只共享 core 领域词汇）：
 * - 块证据：reference 模式指向来源存储（source_type + source_id），内容不重复落库；
 *   已注册过证据的来源复用既有证据行（同源唯一），只为本块首次处理的来源新造证据；
 * - 块提示词：把块消息整理为本轮用户消息，模型只管看内容对表操作；
 * - 任务输入 = 原始消息内容（不套清洗规则——ST Regex 由用户自行负责）。
 */
import type { MemoryEvidence, MemoryEvidenceId, MemorySpaceId } from "@ste-memory/core/memory";
import { EVIDENCE_FLOOR_SOURCE_TYPE } from "../constants.ts";
import type { FillSourceMessage } from "./fill-task.ts";

/**
 * 块证据：reference 模式指向来源存储（source_type = "sync_floor" + 楼层号），
 * 内容不重复落库。已注册过证据的来源复用既有证据行（memory_evidence 对同源唯一），
 * 只为本块首次处理的来源新造证据。
 */
export async function buildBlockEvidence(
  findExisting: (
    memorySpaceId: MemorySpaceId,
    sourceType: string,
    sourceId: string | number,
  ) => Promise<MemoryEvidence | undefined>,
  createEvidenceId: () => MemoryEvidenceId,
  memorySpaceId: MemorySpaceId,
  messages: readonly FillSourceMessage[],
): Promise<readonly MemoryEvidence[]> {
  const result: MemoryEvidence[] = [];
  for (const message of messages) {
    const existing = await findExisting(memorySpaceId, EVIDENCE_FLOOR_SOURCE_TYPE, message.floor);
    if (existing) continue;
    result.push({
      evidence_id: createEvidenceId(),
      source_type: EVIDENCE_FLOOR_SOURCE_TYPE,
      source_id: message.floor,
      storage_mode: "reference",
      extraProps: {},
    });
  }
  return result;
}

export function composeBlockPrompt(
  from: number,
  to: number,
  messages: readonly FillSourceMessage[],
): string {
  const lines = messages.map(
    (message) =>
      `[${message.floor}] ${message.name === "" ? "" : `${message.name}：`}${message.content}`,
  );
  return [
    `以下是需要处理的对话消息（消息 ${from} 到 ${to}，共 ${messages.length} 条）：`,
    ...lines,
    "",
    "请依据这些消息更新记忆表格；确认无需变更时直接结束对话。",
  ].join("\n");
}
