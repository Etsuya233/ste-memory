import { useSyncExternalStore } from "react";

const STORAGE_KEY = "ste-memory.appearance.v1";
const CHANGE_EVENT = "stm-appearance-change";
const OPTIONS = {
  theme: { label: "主题", values: { dark: "深色", light: "浅色" } },
  accent: {
    label: "强调色",
    values: { teal: "青绿", blue: "蓝色", indigo: "靛蓝", neutral: "中性" },
  },
  font: { label: "字体", values: { system: "系统", serif: "宋体" } },
  size: { label: "字号", values: { compact: "紧凑", normal: "标准", large: "大号" } },
} as const;
type Appearance = {
  liquidGlass: boolean;
  theme: "dark" | "light";
  accent: "teal" | "blue" | "indigo" | "neutral";
  font: "system" | "serif";
  size: "compact" | "normal" | "large";
};
const DEFAULT_APPEARANCE: Appearance = {
  liquidGlass: false,
  theme: "dark",
  accent: "teal",
  font: "system",
  size: "normal",
};

function subscribe(listener: () => void) {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useAppearance(): Appearance {
  const stored = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(STORAGE_KEY),
    () => null,
  );
  return stored === null ? DEFAULT_APPEARANCE : { ...DEFAULT_APPEARANCE, ...JSON.parse(stored) };
}

/** 外观属于此设备的界面偏好，不进入记忆备份。 */
export function AppearanceSettings() {
  const appearance = useAppearance();
  return (
    <div className="stm-appearance-settings">
      <div className="stm-setting-row">
        <span>Liquid Glass</span>
        <label className="stm-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Liquid Glass"
            checked={appearance.liquidGlass}
            onChange={(event) => {
              window.localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({ ...appearance, liquidGlass: event.target.checked }),
              );
              window.dispatchEvent(new Event(CHANGE_EVENT));
            }}
          />
          <span className="stm-switch-track" aria-hidden="true" />
        </label>
      </div>
      {(Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]).map((key) => (
        <fieldset className="stm-appearance-field" key={key}>
          <legend>{OPTIONS[key].label}</legend>
          <div className="stm-segmented" aria-label={OPTIONS[key].label}>
            {Object.entries(OPTIONS[key].values).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={appearance[key] === value}
                onClick={() => {
                  window.localStorage.setItem(
                    STORAGE_KEY,
                    JSON.stringify({ ...appearance, [key]: value }),
                  );
                  window.dispatchEvent(new Event(CHANGE_EVENT));
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
