/**
 * 桌面浮动窗口几何（纯逻辑 seam，无 React/DOM 依赖）：
 * 面板在桌面（≥1001px）是居中大尺寸浮动窗口，支持顶栏拖拽移动 + 右下角缩放。
 * 几何以 CSS 变量（--stm-x/y/w/h/tx/ty）落在面板元素上，且只在桌面媒体查询里
 * 被消费——移动端抽屉布局不读取这些变量，拖拽/缩放后的几何对移动端完全惰性。
 *
 * 本模块只做：钳制（视口内 + 最小尺寸）、序列化/校验、localStorage 持久化
 * （仅 UI 窗口状态，不是记忆数据；localStorage 容量/驱逐顾虑不适用）。
 * 组件负责 pointer 事件接线（见 panel-shell.tsx）。
 */

/** 桌面断点（与 ST 移动断点一致，style.css 同源） */
export const DESKTOP_MEDIA_QUERY = "(min-width: 1001px)";

/** 几何持久化键（localStorage；前缀防与其他扩展冲突） */
export const GEOMETRY_STORAGE_KEY = "steMemory.panelGeometry";

/** 桌面窗口最小尺寸（缩放下限） */
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MIN_HEIGHT = 320;

/** 面板与视口边缘的最小留白（位置钳制基准，px） */
export const PANEL_VIEWPORT_MARGIN = 24;

export interface PanelGeometry {
  /** 相对视口左上角的像素坐标；null = 保持默认（居中） */
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number;
  readonly height: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 把几何钳制进当前视口：尺寸不小于最小尺寸、不超过视口（留 --stm 边距），
 * 位置（非居中态）完整落在视口内。居中态（x/y null）不受位置钳制影响。
 */
export function clampGeometry(geometry: PanelGeometry, viewport: ViewportSize): PanelGeometry {
  const maxWidth = Math.max(PANEL_MIN_WIDTH, viewport.width - PANEL_VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(PANEL_MIN_HEIGHT, viewport.height - PANEL_VIEWPORT_MARGIN * 2);
  const width = clamp(geometry.width, PANEL_MIN_WIDTH, maxWidth);
  const height = clamp(geometry.height, PANEL_MIN_HEIGHT, maxHeight);
  const maxX = Math.max(PANEL_VIEWPORT_MARGIN, viewport.width - width - PANEL_VIEWPORT_MARGIN);
  const maxY = Math.max(PANEL_VIEWPORT_MARGIN, viewport.height - height - PANEL_VIEWPORT_MARGIN);
  return {
    x: geometry.x === null ? null : clamp(geometry.x, PANEL_VIEWPORT_MARGIN, maxX),
    y: geometry.y === null ? null : clamp(geometry.y, PANEL_VIEWPORT_MARGIN, maxY),
    width,
    height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function serializeGeometry(geometry: PanelGeometry): string {
  return JSON.stringify(geometry);
}

/**
 * 解析持久化几何：形状/数值非法（旧数据、手改、NaN/Infinity）返回 null，
 * 调用方回退默认（居中）。位置字段允许 null（居中态）。
 */
export function parseGeometry(raw: string | null): PanelGeometry | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { x, y, width, height } = record;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (x !== null && !isFiniteNumber(x)) return null;
  if (y !== null && !isFiniteNumber(y)) return null;
  return { x: x as number | null, y: y as number | null, width, height };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 几何存储端口（测试注入 fake；组件传 safeLocalStorage） */
export interface PanelGeometryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadGeometry(storage: PanelGeometryStorage): PanelGeometry | null {
  return parseGeometry(storage.getItem(GEOMETRY_STORAGE_KEY));
}

export function saveGeometry(storage: PanelGeometryStorage, geometry: PanelGeometry): void {
  storage.setItem(GEOMETRY_STORAGE_KEY, serializeGeometry(geometry));
}

/** localStorage 安全包装：隐私模式等场景 getItem/setItem 可能抛异常，一律吞掉 */
export function safeLocalStorage(): PanelGeometryStorage {
  return {
    getItem(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // 忽略：几何持久化失败不影响面板使用
      }
    },
  };
}
