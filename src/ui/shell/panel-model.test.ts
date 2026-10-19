import { describe, expect, it, vi } from "vitest";
import { PANEL_TAB_LABELS, PANEL_TABS, PanelModel } from "./panel-model.ts";

describe("PanelModel（面板开关与 Tab 状态机）", () => {
  it("初始状态：关闭、抽屉收起、表格 Tab", () => {
    const model = new PanelModel();
    expect(model.getState()).toEqual({ open: false, navOpen: false, tab: "tables" });
  });

  it("toggle 开 ↔ 关", () => {
    const model = new PanelModel();
    model.toggle();
    expect(model.getState().open).toBe(true);
    model.toggle();
    expect(model.getState().open).toBe(false);
  });

  it("open/close 幂等；open 不改变 Tab", () => {
    const model = new PanelModel();
    model.open();
    model.open();
    expect(model.getState().open).toBe(true);
    model.close();
    model.close();
    expect(model.getState().open).toBe(false);
  });

  it("setTab 切换 Tab；重复设置同 Tab 不通知", () => {
    const model = new PanelModel();
    const listener = vi.fn();
    model.onStateChange(listener);

    model.setTab("settings");
    expect(model.getState().tab).toBe("settings");
    expect(listener).toHaveBeenCalledTimes(1);

    model.setTab("settings");
    expect(listener).toHaveBeenCalledTimes(1);

    model.setTab("tables");
    expect(model.getState().tab).toBe("tables");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("Tab 切换发生在关闭状态下也保留（下次打开回到该 Tab）", () => {
    const model = new PanelModel();
    model.setTab("tasks");
    model.open();
    expect(model.getState()).toEqual({ open: true, navOpen: false, tab: "tasks" });
  });

  it("抽屉：toggleNav 切换、setNav 重复设置不通知、closeNav 只收抽屉", () => {
    const model = new PanelModel();
    model.open();
    const listener = vi.fn();
    model.onStateChange(listener);

    model.toggleNav();
    expect(model.getState().navOpen).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    model.setNav(true);
    expect(listener).toHaveBeenCalledTimes(1);

    model.closeNav();
    expect(model.getState().navOpen).toBe(false);
    expect(model.getState().open).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("收起面板时同时收起抽屉；toggle 关闭同理", () => {
    const model = new PanelModel();
    model.open();
    model.setNav(true);
    model.close();
    expect(model.getState()).toEqual({ open: false, navOpen: false, tab: "tables" });

    model.open();
    model.setNav(true);
    model.toggle();
    expect(model.getState()).toEqual({ open: false, navOpen: false, tab: "tables" });
  });

  it("订阅/退订", () => {
    const model = new PanelModel();
    const listener = vi.fn();
    const unsubscribe = model.onStateChange(listener);
    model.open();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    model.close();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("Tab 固定顺序与显示名覆盖全部 Tab（宿主渲染依赖）", () => {
    expect(PANEL_TABS).toEqual(["tables", "records", "tasks", "query", "logs", "settings"]);
    for (const tab of PANEL_TABS) {
      expect(PANEL_TAB_LABELS[tab]).toBeTruthy();
    }
  });
});
