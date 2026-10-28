import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUTO_FILL_SETTINGS,
  validateAutoFillSettings,
  type AutoFillChatState,
} from "../../../features/fill-tasks/auto-fill-settings.ts";
import type { RecordsContext } from "../records-workspace.ts";
import {
  overridesDirty,
  saveAutoFillOverrides,
  type AutoFillServices,
} from "./auto-fill-overrides-model.ts";
const context = { chatKey: "a", spaceId: "space-a", title: "A" } as RecordsContext;
function harness() {
  let state: AutoFillChatState = {
    overrides: { mode: "remind", interval: 5 },
    pausedReason: "保留暂停状态",
  };
  const services: AutoFillServices = {
    read: () => state,
    settings: () => ({ ...DEFAULT_AUTO_FILL_SETTINGS, ...state.overrides }),
    saveOverrides: vi.fn((overrides) => {
      validateAutoFillSettings({ ...DEFAULT_AUTO_FILL_SETTINGS, ...overrides });
      state = { ...state, overrides };
    }),
    assertContext: vi.fn(),
  };
  return {
    services,
    externalChange: () => {
      state = { ...state, overrides: { ...state.overrides, blockSize: 7 } };
    },
  };
}
describe("conversation auto fill edits", () => {
  it("detects and saves hide-only changes while preserving concurrent edits", () => {
    const { services, externalChange } = harness();
    const saved = services.read().overrides;
    const draft = { ...saved, hideAfterSuccess: true, keepRecentFloors: 0 };
    expect(overridesDirty(saved, { ...saved, hideAfterSuccess: false })).toBe(true);
    expect(overridesDirty(saved, { ...saved, keepRecentFloors: 0 })).toBe(true);
    externalChange();
    expect(saveAutoFillOverrides(services, context, saved, draft)).toEqual({
      ...draft,
      blockSize: 7,
    });
    expect(services.read().pausedReason).toBe("保留暂停状态");
  });
  it("removes hidden-floor overrides when resetting all fields to global inheritance", () => {
    const { services } = harness();
    services.saveOverrides({ hideAfterSuccess: true, keepRecentFloors: 0 });
    const saved = services.read().overrides;
    expect(overridesDirty(saved, {})).toBe(true);
    expect(saveAutoFillOverrides(services, context, saved, {})).toEqual({});
    expect(services.settings()).toEqual(DEFAULT_AUTO_FILL_SETTINGS);
  });
  it("rejects invalid keep counts without changing the saved overrides", () => {
    const { services } = harness();
    const saved = services.read().overrides;
    expect(() =>
      saveAutoFillOverrides(services, context, saved, { ...saved, keepRecentFloors: -1 }),
    ).toThrow("保留最近楼层数须为非负整数");
    expect(services.read().overrides).toEqual(saved);
  });
  it("merges only edited fields into the latest overrides and preserves task metadata", () => {
    const { services, externalChange } = harness();
    const saved = services.read().overrides;
    externalChange();
    const result = saveAutoFillOverrides(services, context, saved, { ...saved, interval: 8 });
    expect(result).toEqual({ mode: "remind", interval: 8, blockSize: 7 });
    expect(services.read().pausedReason).toBe("保留暂停状态");
  });
  it("removes explicit values when choosing global inheritance", () => {
    const { services } = harness();
    const saved = services.read().overrides;
    saveAutoFillOverrides(services, context, saved, {});
    expect(services.read().overrides).toEqual({});
    expect(services.settings()).toEqual(DEFAULT_AUTO_FILL_SETTINGS);
  });
  it("rejects a stale live conversation before saving any overrides", () => {
    const { services } = harness();
    vi.mocked(services.assertContext).mockImplementation(() => {
      throw new Error("chat changed");
    });
    expect(() =>
      saveAutoFillOverrides(services, context, services.read().overrides, { interval: 9 }),
    ).toThrow("chat changed");
    expect(services.saveOverrides).not.toHaveBeenCalled();
  });
});
