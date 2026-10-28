import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../../features/settings/plugin-settings.ts";
import type { CleaningRule } from "../../../features/cleaning/cleaning-rules.ts";
import type { SettingsServices } from "./settings-actions.ts";
import { deleteCleaningRule, persistCleaningRule } from "./cleaning-settings-model.ts";

const rule: CleaningRule = {
  id: "rule-a",
  name: "正文",
  enabled: true,
  excludeTags: [{ pre: "<think>", post: "</think>" }],
  keepTags: [],
};
function harness() {
  let current = structuredClone(DEFAULT_SETTINGS);
  const save = vi.fn((next: typeof current) => {
    current = next;
  });
  const services = {
    settings: { read: () => current, save },
    onChanged: vi.fn(async () => {}),
  } as unknown as SettingsServices;
  return { services, save };
}

describe("cleaning settings persistence", () => {
  it("merges the edited rule with newly saved global settings and other rules", async () => {
    const { services } = harness();
    const other = { ...rule, id: "rule-b", name: "其他规则" };
    services.settings.save({
      ...services.settings.read(),
      macroLimit: 9876,
      cleaningRules: [rule, other],
    });
    const result = await persistCleaningRule(services, { ...rule, name: " 新正文 " }, rule);
    expect(result.saved).toBe(true);
    expect(services.settings.read()).toMatchObject({
      macroLimit: 9876,
      cleaningRules: [{ ...rule, name: "新正文" }, other],
    });
  });
  it("rejects schema conflicts before saving or refreshing", async () => {
    const { services, save } = harness();
    services.settings.save({
      ...services.settings.read(),
      cleaningRules: [{ ...rule, name: "其他编辑" }],
    });
    save.mockClear();
    await expect(
      persistCleaningRule(services, { ...rule, name: "我的草稿" }, rule),
    ).rejects.toThrow("已被其他操作修改");
    expect(save).not.toHaveBeenCalled();
    expect(services.onChanged).not.toHaveBeenCalled();
  });
  it("reports saved data when the host refresh rejects without replaying mutation", async () => {
    const { services, save } = harness();
    vi.mocked(services.onChanged).mockRejectedValueOnce(new Error("同步失败"));
    const result = await persistCleaningRule(services, rule, null);
    expect(result).toMatchObject({ saved: true, error: "同步失败" });
    expect(save).toHaveBeenCalledOnce();
    expect(services.settings.read().cleaningRules).toHaveLength(1);
  });
  it("removes only the selected rule and preserves newer unrelated settings", async () => {
    const { services } = harness();
    const other = { ...rule, id: "rule-b" };
    services.settings.save({
      ...services.settings.read(),
      fillAgentTimeoutSeconds: 90,
      cleaningRules: [rule, other],
    });
    await deleteCleaningRule(services, rule);
    expect(services.settings.read()).toMatchObject({
      fillAgentTimeoutSeconds: 90,
      cleaningRules: [other],
    });
  });
});
