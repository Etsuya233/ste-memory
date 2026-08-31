/**
 * Agent 预设预览 model（issue 01）：把活动预设 + 点击预览时即时构建的展开数据
 * 投影为预览条目序列（启用且非空消息逐条：角色标签 + 来源预设消息名 + 展开后
 * 文本 + 可选标注）。全部为纯函数，组件只接线（展开数据由宿主端口构建）。
 *
 * 与真实编排的差异只落在展示分组（组件按编排形态分组：system 合并进系统提示词、
 * user/assistant 进入对话前缀），展开语义与 composePresetMessages 完全同源
 * （expandAgentPresetPlaceholders：单遍替换、未知占位符原样保留）。
 * 无活动空间（digest = undefined）时 {{tablesDigest}}/{{systemDefaultPrompt}}
 * 展开空串（与任务语义一致——没有空间就没有摘要）。
 */
import type { MemorySpaceTableDigest } from "@ste-memory/core/memory/agent";
import type { MemorySpaceId } from "@ste-memory/core/memory";
import {
  AGENT_PRESET_PLACEHOLDERS,
  expandAgentPresetPlaceholders,
  type AgentPromptSnapshot,
} from "./preset-composer.ts";
import type { AgentPresetRole, AgentPresetMessage, AgentPromptPreset } from "./preset-model.ts";

/** 世界书扫描状态（{{worldbook}} 标注源）：skipped = 预览输入为空未扫描 */
export type PreviewWorldbookState = "scanned" | "skipped" | "failed";

/** 预览条目：一条启用且非空消息展开后的最终形态（卡片数据源） */
export interface AgentPresetPreviewItem {
  readonly id: string;
  readonly role: AgentPresetRole;
  /** 来源预设消息名（空名回退内容首行）；「未命名消息」兜底 */
  readonly sourceName: string;
  /** 展开后文本（未知占位符原样保留） */
  readonly text: string;
  /** 面板标注（{{msg}} 无输入 / 世界书未扫描或扫描失败）；无标注 = undefined */
  readonly note: string | undefined;
}

/** 预览构建输入：全部数据在点击时由宿主端口即时构建 */
export interface AgentPresetPreviewBuildInput {
  readonly preset: AgentPromptPreset;
  /** 占位符展开快照（msgText / worldbookText 已按预览输入填充） */
  readonly snapshot: AgentPromptSnapshot;
  /** 活动空间摘要；undefined = 无活动空间（digest 占位符展开空串） */
  readonly digest: MemorySpaceTableDigest | undefined;
  /** 世界书扫描状态：与扫描结果配套描述 {{worldbook}} 展开 */
  readonly worldbookState: PreviewWorldbookState;
}

/** 宿主端口（runtime 组合根实现）：预览展开数据即时构建 */
export interface AgentPresetPreviewPorts {
  /** ST 上下文快照（adapter.getPromptSnapshot 同源；msgText/worldbookText 由调用方填充） */
  readonly getPromptSnapshot: () => AgentPromptSnapshot;
  /** 活动记忆空间 id；undefined = 无活动空间 */
  readonly readSpaceId: () => MemorySpaceId | undefined;
  /** 即时构建空间摘要（digest）；spaceId 非空 */
  readonly readDigest: (memorySpaceId: MemorySpaceId) => Promise<MemorySpaceTableDigest>;
  /** 世界书 dry-run 扫描（输入文本 → 扫描文本 + 状态；旧版 ST / 扫描失败 = failed） */
  readonly scanWorldbook: (text: string) => Promise<{
    readonly text: string;
    readonly status: "scanned" | "failed";
  }>;
}

/** 一次预览构建的完整展开数据（组件状态缓存，重开/刷新时重建） */
export interface AgentPresetPreviewData {
  readonly snapshot: AgentPromptSnapshot;
  readonly digest: MemorySpaceTableDigest | undefined;
  readonly worldbookState: PreviewWorldbookState;
}

/** 空快照（首次加载完成前的占位；msg/worldbook 无输入 = 空串） */
export const EMPTY_PREVIEW_SNAPSHOT: AgentPromptSnapshot = {
  names: { user: "", char: "" },
  charCard: "",
  userCard: "",
  worldbookText: "",
  msgText: "",
};

/** 构建预览条目序列：每启用且非空消息一条，展开 + 来源名 + 标注（纯函数，可单测） */
export function buildAgentPresetPreviewItems(
  input: AgentPresetPreviewBuildInput,
): readonly AgentPresetPreviewItem[] {
  // 输入为空判定 = 展开快照里的 msgText（预览构建时由宿主按输入填充）——
  // 标注必须与面板实际展示的展开结果一致（未点「重新展开」前的滞留数据不参与）
  const inputEmpty = input.snapshot.msgText.trim() === "";
  return input.preset.messages
    .filter((message) => message.enabled && message.content.trim() !== "")
    .map((message) => ({
      id: message.id,
      role: message.role,
      sourceName: previewSourceName(message),
      text: expandAgentPresetPlaceholders(message.content, input.snapshot, input.digest),
      note: previewNote(message, inputEmpty, input.worldbookState),
    }));
}

/** 来源名：命名消息用名，空名回退内容首行，再兜底「未命名消息」 */
function previewSourceName(message: AgentPresetMessage): string {
  if (message.name.trim() !== "") return message.name;
  const firstLine = (message.content.split("\n")[0] ?? "").trim();
  return firstLine === "" ? "未命名消息" : firstLine;
}

/** 面板标注：只落在引用对应占位符的卡片上（无引用不打扰） */
function previewNote(
  message: AgentPresetMessage,
  inputEmpty: boolean,
  worldbookState: PreviewWorldbookState,
): string | undefined {
  if (inputEmpty && message.content.includes(AGENT_PRESET_PLACEHOLDERS.msg)) {
    return "{{msg}} 依赖任务块消息，预览中无输入 → 展开为空串";
  }
  if (message.content.includes(AGENT_PRESET_PLACEHOLDERS.worldbook)) {
    if (worldbookState === "skipped") return "输入为空，未执行世界书扫描 → 展开为空串";
    if (worldbookState === "failed") return "世界书扫描失败（旧版 ST 或扫描异常）→ 展开为空串";
  }
  return undefined;
}
