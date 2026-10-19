/**
 * 外观四旋钮的展示模型（纯逻辑）：选项顺序 + 中文标签 + 折叠摘要。
 * 值域与校验在 features/settings/plugin-settings（内存形状），这里只管展示；
 * 顺序与原型（.scratch/ui-redesign/prototype.html）一致。
 */

import {
  APPEARANCE_ACCENTS,
  APPEARANCE_FONTS,
  APPEARANCE_SIZES,
  APPEARANCE_THEMES,
  type AppearanceAccent,
  type AppearanceFont,
  type AppearanceSettings,
  type AppearanceSize,
  type AppearanceTheme,
} from "../../features/settings/plugin-settings.ts";

export const APPEARANCE_THEME_OPTIONS: readonly AppearanceTheme[] = APPEARANCE_THEMES;
export const APPEARANCE_ACCENT_OPTIONS: readonly AppearanceAccent[] = APPEARANCE_ACCENTS;
export const APPEARANCE_FONT_OPTIONS: readonly AppearanceFont[] = APPEARANCE_FONTS;
export const APPEARANCE_SIZE_OPTIONS: readonly AppearanceSize[] = APPEARANCE_SIZES;

export const APPEARANCE_THEME_LABELS: Readonly<Record<AppearanceTheme, string>> = {
  dark: "深色",
  light: "浅色",
};

export const APPEARANCE_ACCENT_LABELS: Readonly<Record<AppearanceAccent, string>> = {
  blue: "系统蓝",
  neutral: "中性白",
  indigo: "靛蓝",
  teal: "青绿",
};

export const APPEARANCE_FONT_LABELS: Readonly<Record<AppearanceFont, string>> = {
  system: "系统",
  serif: "衬线",
};

export const APPEARANCE_SIZE_LABELS: Readonly<Record<AppearanceSize, string>> = {
  compact: "紧凑",
  normal: "标准",
  large: "大",
};

/** 折叠头摘要：「深色 · 青绿 · 系统 · 标准」 */
export function appearanceSummary(appearance: AppearanceSettings): string {
  return [
    APPEARANCE_THEME_LABELS[appearance.theme],
    APPEARANCE_ACCENT_LABELS[appearance.accent],
    APPEARANCE_FONT_LABELS[appearance.font],
    APPEARANCE_SIZE_LABELS[appearance.size],
  ].join(" · ");
}
