/**
 * 桌面浮动窗口几何纯逻辑测试（无 jsdom，沿用仓库纯逻辑 seam 测试决策）。
 * DOM 接线（pointer 拖拽/缩放）由真机验收脚本 verify-ui-shell.mjs 覆盖。
 */
import { describe, expect, it } from "vitest";
import {
  GEOMETRY_STORAGE_KEY,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_VIEWPORT_MARGIN,
  clampGeometry,
  loadGeometry,
  parseGeometry,
  saveGeometry,
  serializeGeometry,
  type PanelGeometry,
  type PanelGeometryStorage,
} from "./panel-window.ts";

describe("clampGeometry（视口钳制）", () => {
  it("居中态（x/y null）保持居中，尺寸钳制进视口", () => {
    const geo = clampGeometry({ x: null, y: null, width: 2000, height: 3000 }, { width: 1280, height: 800 });
    expect(geo).toEqual({ x: null, y: null, width: 1232, height: 752 });
  });

  it("尺寸不小于最小尺寸", () => {
    const geo = clampGeometry({ x: null, y: null, width: 100, height: 100 }, { width: 1280, height: 800 });
    expect(geo.width).toBe(PANEL_MIN_WIDTH);
    expect(geo.height).toBe(PANEL_MIN_HEIGHT);
  });

  it("拖拽位置钳制在视口内（四周留边距）", () => {
    const viewport = { width: 1280, height: 800 };
    const geo = clampGeometry({ x: 100000, y: -50, width: 720, height: 680 }, viewport);
    expect(geo.x).toBe(viewport.width - 720 - PANEL_VIEWPORT_MARGIN);
    expect(geo.y).toBe(PANEL_VIEWPORT_MARGIN);
  });

  it("视口小于最小尺寸时保持最小尺寸（不产生负上限）", () => {
    const geo = clampGeometry({ x: null, y: null, width: 500, height: 400 }, { width: 300, height: 200 });
    expect(geo).toEqual({ x: null, y: null, width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT });
  });

  it("位置钳制边界：正好落在边距与最大坐标上时原样保留", () => {
    const viewport = { width: 1280, height: 800 };
    const geo = clampGeometry({ x: PANEL_VIEWPORT_MARGIN, y: 800 - 680 - PANEL_VIEWPORT_MARGIN, width: 720, height: 680 }, viewport);
    expect(geo).toEqual({ x: PANEL_VIEWPORT_MARGIN, y: 96, width: 720, height: 680 });
  });
});

describe("parseGeometry / serializeGeometry", () => {
  it("解析合法 JSON（含居中态）", () => {
    expect(parseGeometry('{"x":100,"y":50,"width":700,"height":600}')).toEqual({
      x: 100,
      y: 50,
      width: 700,
      height: 600,
    });
    expect(parseGeometry('{"x":null,"y":null,"width":720,"height":680}')).toEqual({
      x: null,
      y: null,
      width: 720,
      height: 680,
    });
  });

  it("拒绝非法输入：非 JSON / 非对象 / 缺字段 / 非数字 / 非有限数", () => {
    const invalid: Array<string | null> = [
      null,
      "",
      "abc",
      "[]",
      "{}",
      '{"width":"720","height":680}',
      '{"width":720}',
      '{"x":"10","y":50,"width":720,"height":680}',
      '{"x":10,"y":50,"width":720,"height":NaN}',
      '{"x":10,"y":50,"width":720,"height":Infinity}',
    ];
    for (const raw of invalid) {
      expect(parseGeometry(raw), `raw=${raw}`).toBeNull();
    }
  });

  it("未知多余键保留但不影响解析（向前兼容）", () => {
    expect(parseGeometry('{"x":10,"y":20,"width":800,"height":600,"future":true}')).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600,
    });
  });

  it("与 serializeGeometry 往返一致", () => {
    const geo: PanelGeometry = { x: 10, y: 20, width: 800, height: 600 };
    expect(parseGeometry(serializeGeometry(geo))).toEqual(geo);
  });
});

describe("loadGeometry / saveGeometry（持久化端口）", () => {
  it("写入固定键并可读回", () => {
    const storage = fakeStorage();
    const geo: PanelGeometry = { x: 1, y: 2, width: 500, height: 400 };
    saveGeometry(storage, geo);
    expect(storage.getItem(GEOMETRY_STORAGE_KEY)).toBe(JSON.stringify(geo));
    expect(loadGeometry(storage)).toEqual(geo);
  });

  it("无持久化数据返回 null", () => {
    expect(loadGeometry(fakeStorage())).toBeNull();
  });
});

function fakeStorage(): PanelGeometryStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}
