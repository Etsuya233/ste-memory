import type { ComponentProps, CSSProperties } from "react";

export interface ThemeOptions {
  readonly appearance: "glass" | "classic" | "material";
  readonly tone: "light" | "dark";
  readonly background: string;
  readonly accent: string;
  readonly accentForeground: string;
}

/** Spread on an existing root (including a dialog/popover), without adding a wrapper. */
export function themeAttributes(options: ThemeOptions) {
  return {
    "data-style": options.appearance,
    "data-tone": options.tone,
    style: {
      "--ui-bg": options.background,
      "--ui-accent": options.accent,
      "--ui-accent-fg": options.accentForeground,
    } as CSSProperties,
  };
}

export function Theme({
  theme,
  className = "",
  style,
  ...props
}: ComponentProps<"div"> & {
  readonly theme: ThemeOptions;
}) {
  const attributes = themeAttributes(theme);
  return (
    <div
      {...props}
      {...attributes}
      className={`ui-theme ${className}`}
      style={{ ...attributes.style, ...style }}
    />
  );
}
