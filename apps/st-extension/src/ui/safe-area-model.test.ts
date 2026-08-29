/**
 * 面板安全区模型测试（纯逻辑 seam）：默认值、解析回退、数值域、预设、摘要。
 * 只测模型外部行为，不测 CSS 消费与面板投影（冒烟层覆盖）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFE_AREA,
  SAFE_AREA_EDGES,
  SAFE_AREA_MAX_VALUE,
  SAFE_AREA_PRESETS,
  SAFE_AREA_STORAGE_KEY,
  clampSafeAreaValue,
  loadSafeArea,
  parseSafeArea,
  safeAreaSummary,
  saveSafeArea,
  serializeSafeArea,
  type PanelSafeArea,
} from "./safe-area-model.ts";

function fakeStorage(initial: Record<string, string> = {}): {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  map: Record<string, string>;
} {
  const map = { ...initial };
  return {
    getItem: (k) => map[k] ?? null,
    setItem: (k, v) => {
      map[k] = v;
    },
    map,
  };
}

describe("safe-area-model（面板安全区）", () => {
  it("默认四边全 0（未配置行为与现状一致）", () => {
    expect(DEFAULT_SAFE_AREA).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(SAFE_AREA_EDGES).toEqual(["top", "bottom", "left", "right"]);
    expect(SAFE_AREA_MAX_VALUE).toBe(120);
  });

  it("空存储 → 默认（全 0）", () => {
    expect(loadSafeArea(fakeStorage())).toEqual(DEFAULT_SAFE_AREA);
  });

  it("往返：保存后可加载，键稳定", () => {
    const storage = fakeStorage();
    const area: PanelSafeArea = { top: 59, bottom: 34, left: 0, right: 0 };
    saveSafeArea(storage, area);
    expect(storage.map[SAFE_AREA_STORAGE_KEY]).toBe(
      JSON.stringify({ top: 59, bottom: 34, left: 0, right: 0 }),
    );
    expect(loadSafeArea(storage)).toEqual(area);
  });

  it("损坏 JSON → 整体回退默认", () => {
    const storage = fakeStorage({ [SAFE_AREA_STORAGE_KEY]: "not-json" });
    expect(loadSafeArea(storage)).toEqual(DEFAULT_SAFE_AREA);
  });

  it("非对象/数组 → 整体回退默认", () => {
    expect(parseSafeArea("42")).toEqual(DEFAULT_SAFE_AREA);
    expect(parseSafeArea(JSON.stringify([1, 2, 3]))).toEqual(DEFAULT_SAFE_AREA);
    expect(parseSafeArea(JSON.stringify("top"))).toEqual(DEFAULT_SAFE_AREA);
    expect(parseSafeArea(null)).toEqual(DEFAULT_SAFE_AREA);
  });

  it("部分字段缺失 → 整体回退默认", () => {
    expect(parseSafeArea(JSON.stringify({ top: 59, bottom: 34, left: 0 }))).toEqual(
      DEFAULT_SAFE_AREA,
    );
  });

  it("越界值（超上限/负值）→ 整体回退默认（存储不钳制）", () => {
    expect(parseSafeArea(JSON.stringify({ top: 200, bottom: 34, left: 0, right: 0 }))).toEqual(
      DEFAULT_SAFE_AREA,
    );
    expect(parseSafeArea(JSON.stringify({ top: -1, bottom: 34, left: 0, right: 0 }))).toEqual(
      DEFAULT_SAFE_AREA,
    );
  });

  it("非整数/非数字 → 整体回退默认", () => {
    expect(parseSafeArea(JSON.stringify({ top: 59.5, bottom: 34, left: 0, right: 0 }))).toEqual(
      DEFAULT_SAFE_AREA,
    );
    expect(parseSafeArea(JSON.stringify({ top: "59", bottom: 34, left: 0, right: 0 }))).toEqual(
      DEFAULT_SAFE_AREA,
    );
  });

  it("合法存储原样返回（不改写）", () => {
    const area: PanelSafeArea = { top: 47, bottom: 34, left: 10, right: 12 };
    expect(parseSafeArea(JSON.stringify(area))).toEqual(area);
  });

  it("serializeSafeArea：形状 JSON", () => {
    expect(serializeSafeArea(DEFAULT_SAFE_AREA)).toBe(
      JSON.stringify({ top: 0, bottom: 0, left: 0, right: 0 }),
    );
  });

  it("clampSafeAreaValue：钳制到 0～120 并取整", () => {
    expect(clampSafeAreaValue(-5)).toBe(0);
    expect(clampSafeAreaValue(200)).toBe(120);
    expect(clampSafeAreaValue(3.2)).toBe(3);
    expect(clampSafeAreaValue(3.7)).toBe(4);
    expect(clampSafeAreaValue(59)).toBe(59);
  });

  it("预设：灵动岛与刘海屏推荐值精确、id 稳定", () => {
    expect(SAFE_AREA_PRESETS).toHaveLength(2);
    expect(SAFE_AREA_PRESETS[0]).toEqual({
      id: "iphone-dynamic-island",
      label: "iPhone 灵动岛",
      values: { top: 59, bottom: 34, left: 0, right: 0 },
    });
    expect(SAFE_AREA_PRESETS[1]).toEqual({
      id: "iphone-notch",
      label: "iPhone 刘海屏",
      values: { top: 47, bottom: 34, left: 0, right: 0 },
    });
  });

  it("safeAreaSummary：全 0 → 未调整", () => {
    expect(safeAreaSummary(DEFAULT_SAFE_AREA)).toBe("未调整");
  });

  it("safeAreaSummary：任意边非 0 → 四边值", () => {
    expect(safeAreaSummary({ top: 59, bottom: 34, left: 0, right: 0 })).toBe(
      "上59 · 下34 · 左0 · 右0",
    );
  });
});