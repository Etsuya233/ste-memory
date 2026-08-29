/**
 * 面板安全区模型（纯逻辑 seam）：移动端布局下面板相对视口四边的可配置内缩。
 * 本机显示偏好（设备相关，语义同面板几何）：存 localStorage，不进
 * PluginSettings/备份/云同步；默认全 0 = 行为与未配置一致。
 * 仅移动断点（<1001px）消费，桌面浮动窗口有独立 24px 视口钳制，不读这些值。
 */

/** 面板安全区持久化键（localStorage；与面板几何键同前缀防冲突） */
export const SAFE_AREA_STORAGE_KEY = "steMemory.panelSafeArea";

/** 单边内缩上限（px）；UI 输入钳制到 [0, 120] 整数，存储越界则整体回退默认 */
export const SAFE_AREA_MAX_VALUE = 120;

/** 四边顺序（UI 渲染与校验共用） */
export const SAFE_AREA_EDGES = ["top", "bottom", "left", "right"] as const;

export type SafeAreaEdge = (typeof SAFE_AREA_EDGES)[number];

/** 四边中文标签（UI 投影的唯一来源） */
export const SAFE_AREA_EDGE_LABELS: Readonly<Record<SafeAreaEdge, string>> = {
  top: "上",
  bottom: "下",
  left: "左",
  right: "右",
};

export interface PanelSafeArea {
  /** 顶部内缩（px），避开状态栏/灵动岛 */
  readonly top: number;
  /** 底部内缩（px），避开手势条/Home Indicator */
  readonly bottom: number;
  /** 左侧内缩（px），横屏时避开圆角/挖孔 */
  readonly left: number;
  /** 右侧内缩（px），横屏时避开圆角/挖孔 */
  readonly right: number;
}

export const DEFAULT_SAFE_AREA: PanelSafeArea = { top: 0, bottom: 0, left: 0, right: 0 };

export interface SafeAreaPreset {
  /** 稳定标识（UI data-preset 契约） */
  readonly id: string;
  /** 展示名 */
  readonly label: string;
  readonly values: PanelSafeArea;
}

/** 预设 = 一键填充的推荐值（iOS 安全区常态值；宿主不报 env 时的手动补偿起点） */
export const SAFE_AREA_PRESETS: readonly SafeAreaPreset[] = [
  {
    id: "iphone-dynamic-island",
    label: "iPhone 灵动岛",
    values: { top: 59, bottom: 34, left: 0, right: 0 },
  },
  {
    id: "iphone-notch",
    label: "iPhone 刘海屏",
    values: { top: 47, bottom: 34, left: 0, right: 0 },
  },
];

/** 存储端口（测试注入 fake；生产传 safeLocalStorage） */
export interface SafeAreaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** UI 输入钳制：范围 [0, 120] 并取整到整数（非法输入在调用方不落库） */
export function clampSafeAreaValue(value: number): number {
  return Math.min(SAFE_AREA_MAX_VALUE, Math.max(0, Math.round(value)));
}

function isSafeArea(value: unknown): value is PanelSafeArea {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return SAFE_AREA_EDGES.every((edge) => isSafeEdgeValue(record[edge]));
}

function isSafeEdgeValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= SAFE_AREA_MAX_VALUE
  );
}

/**
 * 解析持久化安全区：形状/数值非法（旧数据、手改、NaN/Infinity、越界、非整数）
 * 整体回退默认（与面板几何解析同风格，不弹错、不逐边钳制）。
 */
export function parseSafeArea(raw: string | null): PanelSafeArea {
  if (raw === null) return DEFAULT_SAFE_AREA;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SAFE_AREA;
  }
  return isSafeArea(parsed) ? parsed : DEFAULT_SAFE_AREA;
}

export function serializeSafeArea(area: PanelSafeArea): string {
  return JSON.stringify(area);
}

export function loadSafeArea(storage: SafeAreaStorage): PanelSafeArea {
  return parseSafeArea(storage.getItem(SAFE_AREA_STORAGE_KEY));
}

export function saveSafeArea(storage: SafeAreaStorage, area: PanelSafeArea): void {
  try {
    storage.setItem(SAFE_AREA_STORAGE_KEY, serializeSafeArea(area));
  } catch {
    // 与几何持久化同理：失败不影响面板使用
  }
}

/** 折叠头摘要：全 0 显示“未调整”，否则显示四边值 */
export function safeAreaSummary(area: PanelSafeArea): string {
  if (SAFE_AREA_EDGES.every((edge) => area[edge] === 0)) return "未调整";
  return `上${area.top} · 下${area.bottom} · 左${area.left} · 右${area.right}`;
}