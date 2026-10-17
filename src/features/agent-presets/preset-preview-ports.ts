import type { MemorySpaceId } from "../memory/index.ts";
import type { MemorySpaceTableDigest } from "../agent/index.ts";
import type { AgentPromptSnapshot } from "./preset-composer.ts";
import type { AgentPresetPreviewPorts } from "./preset-preview-model.ts";
import { scanWorldbookText, type WorldbookScanContext } from "./worldbook-text.ts";

/**
 * Agent 预设预览端口装配（issue 01）：预览点击时即时构建展开数据——
 * ST 上下文快照 + 活动空间 digest + 世界书 dry-run 扫描；组件只消费端口。
 * 世界书扫描失败或旧版 ST 无扫描入口 → 空串 + failed 状态（面板标注），不阻断预览。
 */
export interface PresetPreviewPortsOptions {
  /** ST 上下文快照（宿主 = ST 适配器；msgText/worldbookText 由预览填充） */
  readonly readSnapshot: () => AgentPromptSnapshot;
  /** 活动记忆空间 id；undefined = 无活动空间 */
  readonly readSpaceId: () => MemorySpaceId | undefined;
  /** 即时构建空间摘要（digest） */
  readonly readDigest: (memorySpaceId: MemorySpaceId) => Promise<MemorySpaceTableDigest>;
  /** ST 上下文（世界书 dry-run 扫描；旧版 ST 缺扫描入口） */
  readonly getStContext: () => WorldbookScanContext;
  /** 世界书扫描失败告警（宿主带插件前缀；不阻断预览） */
  readonly logWarn: (message: string) => void;
}

export function createPresetPreviewPorts(
  options: PresetPreviewPortsOptions,
): AgentPresetPreviewPorts {
  return {
    getPromptSnapshot: () => options.readSnapshot(),
    readSpaceId: () => options.readSpaceId(),
    readDigest: (memorySpaceId) => options.readDigest(memorySpaceId),
    scanWorldbook: async (text) => {
      const context = options.getStContext();
      if (!context.getWorldInfoPrompt) {
        // 旧版 ST 无扫描入口：与真实链路同语义（展开空串不阻断），状态 failed 供面板标注
        return { text: "", status: "failed" };
      }
      try {
        return { text: await scanWorldbookText(context, text), status: "scanned" };
      } catch (error) {
        options.logWarn(
          `预设预览世界书扫描失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return { text: "", status: "failed" };
      }
    },
  };
}
