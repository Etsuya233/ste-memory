import {
  containsWorldbookReference,
  resolveActivePreset,
  type AgentPresetSettings,
} from "../agent-presets/preset-model.ts";
import { scanWorldbookText, type WorldbookScanContext } from "../agent-presets/worldbook-text.ts";
import type { AgentPromptSnapshot } from "../agent-presets/preset-composer.ts";
import type { FillTaskPromptContext } from "./fill-task-service.ts";

/**
 * 填表任务的编排上下文工厂（ADR 0024 组装迁移）：提交时构造一次**纯数据**
 * （活动预设 + 占位符展开快照，无方法）——预设解析 + 对话快照 + 世界书扫描文本。
 * 块级 {{msg}} 由块循环按块注入。
 *
 * 系统默认预设 → undefined（service 走核心默认提示词）。
 * 预设启用消息含 {{worldbook}} 才扫描（零引用零开销）；扫描失败 → 空串 + warn，
 * 不阻断任务（用户决策）。
 */
export interface FillTaskPromptContextOptions {
  /** 插件设置里的 Agent 预设（每次构造重取） */
  readonly readPresetSettings: () => AgentPresetSettings;
  /** ST 上下文快照（对话双方名字/角色卡/Persona；宿主 = ST 适配器） */
  readonly readSnapshot: () => AgentPromptSnapshot;
  /** ST 上下文（世界书扫描所需子集；旧版 ST 缺扫描入口 → 空串降级） */
  readonly getStContext: () => WorldbookScanContext;
  /** 世界书扫描失败告警（宿主带插件前缀；不阻断任务） */
  readonly logWarn: (message: string) => void;
}

export function createFillTaskPromptContext(
  options: FillTaskPromptContextOptions,
): (storyText: string) => Promise<FillTaskPromptContext | undefined> {
  return async (storyText) => {
    const preset = resolveActivePreset(options.readPresetSettings());
    if (!preset) return undefined;
    let worldbookText = "";
    if (containsWorldbookReference(preset)) {
      try {
        worldbookText = await scanWorldbookText(options.getStContext(), storyText);
      } catch (error) {
        options.logWarn(
          `世界书扫描失败，{{worldbook}} 展开为空：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return {
      preset,
      snapshot: { ...options.readSnapshot(), worldbookText },
    };
  };
}
