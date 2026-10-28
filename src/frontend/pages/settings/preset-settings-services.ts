import type { MemorySpaceId } from "../../../features/memory/index.ts";
import type { AgentPresetPreviewPorts } from "../../../features/agent-presets/preset-preview-model.ts";
import type {
  ResolvedTablePreset,
  TablePresetStructure,
} from "../../../features/table-presets/preset-model.ts";
import type { ApplyTablePresetOutcome } from "../../../features/table-presets/table-preset-apply-service.ts";
import type { PresetSpaceUpdateService } from "../../../features/table-presets/preset-space-update.ts";

export interface PresetContext {
  spaceId: MemorySpaceId;
  chatIdentity: string;
  title: string;
}

export interface PresetSettingsServices {
  spaceUpdate: PresetSpaceUpdateService;
  agentPreview: AgentPresetPreviewPorts;
  currentContext: () => PresetContext | null;
  readCurrentStructure: (context: PresetContext) => Promise<TablePresetStructure>;
  validateTablePreset: (preset: ResolvedTablePreset) => Promise<ResolvedTablePreset>;
  backupCurrentSpace: (context: PresetContext) => Promise<boolean>;
  applyTablePreset: (
    context: PresetContext,
    preset: ResolvedTablePreset,
  ) => Promise<ApplyTablePresetOutcome>;
}
