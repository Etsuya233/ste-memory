/**
 * 外观偏好（本机）：样式 + 主题 + 强调色 + 字体/字号。
 *
 * 主题不再区分「亮色 / 暗色」：每个主题预设直接给出一块底色，面板的层次、
 * 文本与边框由 `data-tone` 根据底色亮度推导。自定义模式同样只选两块颜色
 * （主题色 + 强调色），不需要用户理解深浅模式。
 *
 * 纯逻辑模块：持久化形状、旧版迁移、颜色对比与面板 CSS 变量都在这里，组件只接线。
 */

export const APPEARANCE_STORAGE_KEY = "ste-memory.appearance.v2";
export const LEGACY_APPEARANCE_STORAGE_KEY = "ste-memory.appearance.v1";
export const APPEARANCE_CHANGE_EVENT = "stm-appearance-change";

export type AppearanceStyle = "glass" | "classic" | "material";
export type ThemePresetId = "graphite" | "midnight" | "forest" | "porcelain" | "sand" | "custom";
export type AccentPresetId =
  "teal" | "blue" | "indigo" | "violet" | "rose" | "amber" | "neutral" | "custom";
export type AppearanceFont = "system" | "serif";
export type AppearanceSize = "compact" | "normal" | "large";

export interface Appearance {
  readonly style: AppearanceStyle;
  readonly theme: ThemePresetId;
  readonly accent: AccentPresetId;
  /** 自定义主题底色（仅 theme = custom 时消费） */
  readonly customTheme: string;
  /** 自定义强调色（仅 accent = custom 时消费） */
  readonly customAccent: string;
  readonly font: AppearanceFont;
  readonly size: AppearanceSize;
}

export const DEFAULT_APPEARANCE: Appearance = {
  style: "glass",
  theme: "graphite",
  accent: "teal",
  customTheme: "#101014",
  customAccent: "#0d9488",
  font: "system",
  size: "normal",
};

export const STYLE_OPTIONS: readonly {
  readonly value: AppearanceStyle;
  readonly label: string;
  readonly summary: string;
}[] = [
  { value: "glass", label: "Liquid Glass", summary: "半透明玻璃与柔和光晕" },
  { value: "classic", label: "Classic", summary: "实色表面与清晰边界" },
  { value: "material", label: "Material", summary: "MD3 填充色与层叠阴影" },
];

export const THEME_PRESETS: readonly {
  readonly value: Exclude<ThemePresetId, "custom">;
  readonly label: string;
  readonly background: string;
}[] = [
  { value: "graphite", label: "墨灰", background: "#09090b" },
  { value: "midnight", label: "午夜蓝", background: "#0b1220" },
  { value: "forest", label: "松林", background: "#0b1511" },
  { value: "porcelain", label: "瓷白", background: "#f2f2f7" },
  { value: "sand", label: "沙丘", background: "#e8dfd0" },
];

export const ACCENT_PRESETS: readonly {
  readonly value: Exclude<AccentPresetId, "custom">;
  readonly label: string;
  readonly color: string;
}[] = [
  { value: "teal", label: "青绿", color: "#0d9488" },
  { value: "blue", label: "蓝色", color: "#2563eb" },
  { value: "indigo", label: "靛蓝", color: "#6366f1" },
  { value: "violet", label: "紫罗兰", color: "#8b5cf6" },
  { value: "rose", label: "玫瑰", color: "#e11d48" },
  { value: "amber", label: "琥珀", color: "#d97706" },
  { value: "neutral", label: "中性", color: "#71717a" },
];

const STYLES = new Set<AppearanceStyle>(["glass", "classic", "material"]);
const THEMES = new Set<ThemePresetId>([...THEME_PRESETS.map((preset) => preset.value), "custom"]);
const ACCENTS = new Set<AccentPresetId>([
  ...ACCENT_PRESETS.map((preset) => preset.value),
  "custom",
]);
const FONTS = new Set<AppearanceFont>(["system", "serif"]);
const SIZES = new Set<AppearanceSize>(["compact", "normal", "large"]);

/** 规范化 #rgb / #rrggbb；非法输入返回 fallback。 */
export function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const raw = value.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 严格解析当前版本；缺省/损坏的字段逐项回退默认值。 */
export function normalizeAppearance(value: unknown): Appearance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_APPEARANCE;
  }
  const record = value as Record<string, unknown>;
  return {
    style: STYLES.has(record.style as AppearanceStyle)
      ? (record.style as AppearanceStyle)
      : DEFAULT_APPEARANCE.style,
    theme: THEMES.has(record.theme as ThemePresetId)
      ? (record.theme as ThemePresetId)
      : DEFAULT_APPEARANCE.theme,
    accent: ACCENTS.has(record.accent as AccentPresetId)
      ? (record.accent as AccentPresetId)
      : DEFAULT_APPEARANCE.accent,
    customTheme: normalizeHexColor(record.customTheme, DEFAULT_APPEARANCE.customTheme),
    customAccent: normalizeHexColor(record.customAccent, DEFAULT_APPEARANCE.customAccent),
    font: FONTS.has(record.font as AppearanceFont)
      ? (record.font as AppearanceFont)
      : DEFAULT_APPEARANCE.font,
    size: SIZES.has(record.size as AppearanceSize)
      ? (record.size as AppearanceSize)
      : DEFAULT_APPEARANCE.size,
  };
}

/**
 * 旧版（v1）迁移：liquidGlass 布尔 → Glass / Classic，dark|light → 墨灰 / 瓷白。
 * 旧 accent 的四个值与新版同名，直接沿用。
 */
export function migrateLegacyAppearance(value: unknown): Appearance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_APPEARANCE;
  }
  const record = value as Record<string, unknown>;
  return normalizeAppearance({
    ...DEFAULT_APPEARANCE,
    style: record.liquidGlass === false ? "classic" : "glass",
    theme: record.theme === "light" ? "porcelain" : "graphite",
    accent: record.accent,
    font: record.font,
    size: record.size,
  });
}

/** 读存储原文：v2 优先，回退 v1 迁移（不写回，用户下次改外观时自然落 v2）。 */
export function parseStoredAppearance(current: string | null, legacy: string | null): Appearance {
  const parsed = parseObject(current);
  if (parsed) return normalizeAppearance(parsed);
  const legacyParsed = parseObject(legacy);
  return legacyParsed ? migrateLegacyAppearance(legacyParsed) : DEFAULT_APPEARANCE;
}

export function resolveThemeBackground(appearance: Appearance): string {
  if (appearance.theme === "custom") {
    return normalizeHexColor(appearance.customTheme, DEFAULT_APPEARANCE.customTheme);
  }
  return (
    THEME_PRESETS.find((preset) => preset.value === appearance.theme)?.background ??
    THEME_PRESETS[0]!.background
  );
}

export function resolveAccentColor(appearance: Appearance): string {
  if (appearance.accent === "custom") {
    return normalizeHexColor(appearance.customAccent, DEFAULT_APPEARANCE.customAccent);
  }
  return (
    ACCENT_PRESETS.find((preset) => preset.value === appearance.accent)?.color ??
    ACCENT_PRESETS[0]!.color
  );
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度（0 黑 → 1 白）。 */
export function relativeLuminance(hex: string): number {
  const color = normalizeHexColor(hex, "#000000").slice(1);
  const r = parseInt(color.slice(0, 2), 16);
  const g = parseInt(color.slice(2, 4), 16);
  const b = parseInt(color.slice(4, 6), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** 底色亮度 → 面板明度方向（阈值 0.42，避免中灰主题摇摆）。 */
export function resolveTone(background: string): "light" | "dark" {
  return relativeLuminance(background) > 0.42 ? "light" : "dark";
}

/** 强调色上的前景色：按 WCAG 对比度在黑/白中取更可读的一侧。 */
export function onAccentColor(accent: string): "#ffffff" | "#09090b" {
  const luminance = relativeLuminance(accent);
  const white = 1.05 / (luminance + 0.05);
  const black = (luminance + 0.05) / 0.05;
  return white >= black ? "#ffffff" : "#09090b";
}

export interface AppearancePresentation {
  readonly tone: "light" | "dark";
  readonly background: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly variables: Readonly<Record<`--ui-${string}`, string>>;
}

/** 面板初始化：把当前外观压成 data-tone 与三条随主题变化的 CSS 变量。 */
export function presentAppearance(appearance: Appearance): AppearancePresentation {
  const background = resolveThemeBackground(appearance);
  const accent = resolveAccentColor(appearance);
  return {
    tone: resolveTone(background),
    background,
    accent,
    accentForeground: onAccentColor(accent),
    variables: {
      "--ui-bg": background,
      "--ui-accent": accent,
      "--ui-accent-fg": onAccentColor(accent),
    },
  };
}
