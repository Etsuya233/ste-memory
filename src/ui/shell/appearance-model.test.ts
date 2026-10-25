import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  DEFAULT_APPEARANCE,
  THEME_PRESETS,
  migrateLegacyAppearance,
  normalizeAppearance,
  normalizeHexColor,
  onAccentColor,
  parseStoredAppearance,
  presentAppearance,
  relativeLuminance,
  resolveAccentColor,
  resolveThemeBackground,
  resolveTone,
} from "./appearance-model.ts";

describe("appearance-model", () => {
  it("默认外观为 Liquid Glass + 墨灰 + 青绿，不再携带深浅模式", () => {
    expect(DEFAULT_APPEARANCE).toMatchObject({
      style: "glass",
      theme: "graphite",
      accent: "teal",
      font: "system",
      size: "normal",
    });
    expect(DEFAULT_APPEARANCE).not.toHaveProperty("theme", "dark");
    expect(DEFAULT_APPEARANCE).not.toHaveProperty("liquidGlass");
  });

  it("规范化：非法枚举回退默认，合法值保留", () => {
    expect(normalizeAppearance(null)).toBe(DEFAULT_APPEARANCE);
    expect(
      normalizeAppearance({
        style: "material",
        theme: "porcelain",
        accent: "rose",
        customTheme: "#ABC",
        customAccent: "not-a-color",
        font: "serif",
        size: "large",
      }),
    ).toEqual({
      style: "material",
      theme: "porcelain",
      accent: "rose",
      customTheme: "#aabbcc",
      customAccent: DEFAULT_APPEARANCE.customAccent,
      font: "serif",
      size: "large",
    });
    expect(normalizeAppearance({ style: "neon", theme: "dark", accent: "pink" })).toMatchObject({
      style: "glass",
      theme: "graphite",
      accent: "teal",
    });
  });

  it("旧版 v1：liquidGlass 与 dark/light 迁移为 Classic/Glass 与预设主题", () => {
    expect(
      migrateLegacyAppearance({
        liquidGlass: false,
        theme: "light",
        accent: "blue",
        font: "serif",
        size: "compact",
      }),
    ).toMatchObject({
      style: "classic",
      theme: "porcelain",
      accent: "blue",
      font: "serif",
      size: "compact",
    });
    expect(migrateLegacyAppearance({ liquidGlass: true, theme: "dark" })).toMatchObject({
      style: "glass",
      theme: "graphite",
    });
  });

  it("读取：v2 优先，缺失时迁移 v1，全部损坏时回退默认", () => {
    expect(
      parseStoredAppearance(
        JSON.stringify({ ...DEFAULT_APPEARANCE, theme: "sand" }),
        JSON.stringify({ liquidGlass: false, theme: "light" }),
      ),
    ).toMatchObject({ theme: "sand", style: "glass" });
    expect(
      parseStoredAppearance(null, JSON.stringify({ liquidGlass: false, theme: "light" })),
    ).toMatchObject({ style: "classic", theme: "porcelain" });
    expect(parseStoredAppearance("{", "[]")).toBe(DEFAULT_APPEARANCE);
  });

  it("自定义主题与强调色只消费各自的 color picker", () => {
    const custom = {
      ...DEFAULT_APPEARANCE,
      theme: "custom" as const,
      accent: "custom" as const,
      customTheme: "#f5f3ee",
      customAccent: "#e11d48",
    };
    expect(resolveThemeBackground(custom)).toBe("#f5f3ee");
    expect(resolveAccentColor(custom)).toBe("#e11d48");
    expect(resolveTone("#f5f3ee")).toBe("light");
    expect(resolveTone("#09090b")).toBe("dark");
  });

  it("强调色前景按 WCAG 对比度在黑白之间选择", () => {
    expect(onAccentColor("#0d9488")).toBe("#09090b");
    expect(onAccentColor("#111827")).toBe("#ffffff");
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
  });

  it("预设表提供稳定顺序与可读色值", () => {
    expect(THEME_PRESETS.map((preset) => preset.value)).toEqual([
      "graphite",
      "midnight",
      "forest",
      "porcelain",
      "sand",
    ]);
    expect(ACCENT_PRESETS.length).toBeGreaterThanOrEqual(6);
    for (const color of [
      ...THEME_PRESETS.map((preset) => preset.background),
      ...ACCENT_PRESETS.map((preset) => preset.color),
    ]) {
      expect(normalizeHexColor(color, "")).toBe(color);
    }
  });

  it("presentAppearance 输出 data-tone 与三条内联变量", () => {
    const presentation = presentAppearance({
      ...DEFAULT_APPEARANCE,
      theme: "porcelain",
      accent: "violet",
    });
    expect(presentation.tone).toBe("light");
    expect(presentation.variables).toEqual({
      "--ui-bg": "#f2f2f7",
      "--ui-accent": "#8b5cf6",
      "--ui-accent-fg": "#09090b",
    });
  });
});
