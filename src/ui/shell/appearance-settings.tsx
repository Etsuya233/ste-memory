import { useSyncExternalStore } from "react";
import {
  ACCENT_PRESETS,
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEY,
  STYLE_OPTIONS,
  THEME_PRESETS,
  parseStoredAppearance,
  resolveAccentColor,
  type Appearance,
  type AppearanceSize,
  type AppearanceFont,
  type AppearanceStyle,
  type AccentPresetId,
  type ThemePresetId,
} from "./appearance-model.ts";

export {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  presentAppearance,
  type Appearance,
} from "./appearance-model.ts";

const OPTIONS = {
  font: { label: "字体", values: { system: "系统", serif: "宋体" } },
  size: { label: "字号", values: { compact: "紧凑", normal: "标准", large: "大号" } },
} as const;

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  return `${safeRead(APPEARANCE_STORAGE_KEY) ?? ""}\u0000${safeRead(LEGACY_APPEARANCE_STORAGE_KEY) ?? ""}`;
}

function subscribe(listener: () => void) {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(APPEARANCE_CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(APPEARANCE_CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useAppearance(): Appearance {
  const stored = useSyncExternalStore(subscribe, readSnapshot, () => null);
  if (stored === null) return DEFAULT_APPEARANCE;
  const [current, legacy] = stored.split("\u0000");
  return parseStoredAppearance(current || null, legacy || null);
}

/** 外观属于此设备的界面偏好，不进入记忆备份。 */
export function AppearanceSettings() {
  const appearance = useAppearance();
  const accentColor = resolveAccentColor(appearance);

  function update(patch: Partial<Appearance>): void {
    const next = { ...appearance, ...patch };
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式等写入失败：仍派发事件，让本次页面立即生效
    }
    window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
  }

  return (
    <div className="stm-appearance-settings stm-grouped-list">
      <fieldset className="stm-appearance-field">
        <legend>界面样式</legend>
        <div className="stm-appearance-style-grid" role="group" aria-label="界面样式">
          {STYLE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.value}
              data-appearance-option="style"
              data-value={option.value}
              aria-pressed={appearance.style === option.value}
              onClick={() => update({ style: option.value as AppearanceStyle })}
            >
              <span className="stm-appearance-style-name">
                {option.label}
                <i className="fa-solid fa-check stm-appearance-check" aria-hidden="true" />
              </span>
              <span className="stm-appearance-style-summary">{option.summary}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="stm-appearance-field">
        <legend>主题</legend>
        <div className="stm-appearance-theme-grid" role="group" aria-label="主题">
          {THEME_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.value}
              data-appearance-option="theme"
              data-value={preset.value}
              aria-pressed={appearance.theme === preset.value}
              title={preset.label}
              onClick={() => update({ theme: preset.value as ThemePresetId })}
            >
              <span
                className="stm-appearance-theme-swatch"
                style={{ background: preset.background }}
                aria-hidden="true"
              >
                <span style={{ background: accentColor }} />
              </span>
              <span className="stm-appearance-theme-label">{preset.label}</span>
              <i className="fa-solid fa-check stm-appearance-check" aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            data-appearance-option="theme"
            data-value="custom"
            aria-pressed={appearance.theme === "custom"}
            title="自定义"
            onClick={() => update({ theme: "custom" })}
          >
            <span
              className="stm-appearance-theme-swatch stm-appearance-theme-swatch--custom"
              style={{ background: appearance.customTheme }}
              aria-hidden="true"
            >
              <span style={{ background: accentColor }} />
            </span>
            <span className="stm-appearance-theme-label">自定义</span>
            <i className="fa-solid fa-check stm-appearance-check" aria-hidden="true" />
          </button>
        </div>
        {appearance.theme === "custom" && (
          <label className="stm-appearance-color-row">
            <span>主题色</span>
            <input
              type="color"
              value={appearance.customTheme}
              aria-label="自定义主题色"
              onChange={(event) => update({ customTheme: event.target.value })}
            />
            <code>{appearance.customTheme}</code>
          </label>
        )}
      </fieldset>

      <fieldset className="stm-appearance-field">
        <legend>强调色</legend>
        <div className="stm-appearance-accent-grid" role="group" aria-label="强调色">
          {ACCENT_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.value}
              data-appearance-option="accent"
              data-value={preset.value}
              aria-pressed={appearance.accent === preset.value}
              aria-label={preset.label}
              title={preset.label}
              onClick={() => update({ accent: preset.value as AccentPresetId })}
            >
              <span
                className="stm-appearance-swatch"
                style={{ background: preset.color }}
                aria-hidden="true"
              />
              <span className="stm-appearance-accent-label">{preset.label}</span>
              <i className="fa-solid fa-check stm-appearance-check" aria-hidden="true" />
            </button>
          ))}
          <button
            type="button"
            data-appearance-option="accent"
            data-value="custom"
            aria-pressed={appearance.accent === "custom"}
            aria-label="自定义强调色"
            title="自定义"
            onClick={() => update({ accent: "custom" })}
          >
            <span
              className="stm-appearance-swatch stm-appearance-swatch--custom"
              aria-hidden="true"
            >
              <i className="fa-solid fa-plus" aria-hidden="true" />
            </span>
            <span className="stm-appearance-accent-label">自定义</span>
            <i className="fa-solid fa-check stm-appearance-check" aria-hidden="true" />
          </button>
        </div>
        {appearance.accent === "custom" && (
          <label className="stm-appearance-color-row">
            <span>强调色</span>
            <input
              type="color"
              value={appearance.customAccent}
              aria-label="自定义强调色"
              onChange={(event) => update({ customAccent: event.target.value })}
            />
            <code>{appearance.customAccent}</code>
          </label>
        )}
      </fieldset>

      {(Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]).map((key) => (
        <fieldset className="stm-appearance-field" key={key}>
          <legend>{OPTIONS[key].label}</legend>
          <div className="stm-segmented" aria-label={OPTIONS[key].label}>
            {Object.entries(OPTIONS[key].values).map(([value, label]) => (
              <button
                type="button"
                key={value}
                data-appearance-option={key}
                data-value={value}
                aria-pressed={appearance[key] === value}
                onClick={() =>
                  update(
                    key === "font"
                      ? { font: value as AppearanceFont }
                      : { size: value as AppearanceSize },
                  )
                }
              >
                <span>{label}</span>
                <i className="fa-solid fa-check stm-appearance-check" aria-hidden="true" />
              </button>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
