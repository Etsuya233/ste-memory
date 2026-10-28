import {
  removeCleaningRule,
  saveCleaningRule,
  validateCleaningRule,
  type CleaningRule,
} from "../../../features/cleaning/cleaning-rules.ts";
import { draftToRule } from "../../../ui/settings/cleaning-rules-manager-model.ts";
import { persistSettingsEdit } from "./connection-settings-model.ts";
import type { SettingsServices } from "./settings-actions.ts";

/** Merge only this rule into the latest global settings; another editor must not be overwritten. */
export async function persistCleaningRule(
  services: SettingsServices,
  rule: CleaningRule,
  original: CleaningRule | null,
) {
  const error = validateCleaningRule(rule);
  if (error) throw new Error(error);
  const normalized = draftToRule(rule, rule.id);
  const settings = services.settings.read();
  const current = settings.cleaningRules.find((item) => item.id === rule.id) ?? null;
  if (JSON.stringify(current) !== JSON.stringify(original))
    throw new Error("清洗规则已被其他操作修改，请保留草稿并重新打开编辑。");
  return persistSettingsEdit(
    services,
    () =>
      services.settings.save({
        ...settings,
        cleaningRules: saveCleaningRule(settings.cleaningRules, normalized),
      }),
    (saved) =>
      JSON.stringify(saved.cleaningRules.find((item) => item.id === rule.id)) ===
      JSON.stringify(normalized),
  );
}

export async function deleteCleaningRule(services: SettingsServices, original: CleaningRule) {
  const settings = services.settings.read();
  const current = settings.cleaningRules.find((item) => item.id === original.id);
  if (JSON.stringify(current) !== JSON.stringify(original))
    throw new Error("清洗规则已被其他操作修改，请重新打开后删除。");
  return persistSettingsEdit(
    services,
    () =>
      services.settings.save({
        ...settings,
        cleaningRules: removeCleaningRule(settings.cleaningRules, original.id),
      }),
    (saved) => !saved.cleaningRules.some((item) => item.id === original.id),
  );
}
