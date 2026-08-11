/**
 * 插件设置模型（纯逻辑层 seam 的一部分）：设置形状 + 默认值合并 + 存储端口。
 * 宿主 = StSettingsStore（ST extension_settings 对象，随 ST settings.json 持久化）。
 *
 * 字段演进：新增设置项只改 DEFAULT_SETTINGS 与 mergeSettings，旧数据自动补齐
 * 默认值（向前兼容）；未知键原样丢弃（读取时只取已知形状）。
 */

/** R2 云同步配置（ticket 08 生效；ticket 06 仅占位展示，UI 控件禁用） */
export interface R2Settings {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

/** 对话文件镜像设置（ticket 16）：随聊天文件同步记忆快照的开关与内容范围 */
export interface ChatMirrorSettings {
  /** 镜像总开关（默认开，跟随插件总开关） */
  readonly enabled: boolean;
  /** 镜像是否包含修订历史（默认开；关闭时 data.history 裁空，体积主要来源） */
  readonly includeHistory: boolean;
}

export interface PluginSettings {
  /** 插件总开关：关闭后不建空间/不同步/事件桥不响应（设置面板开关，ticket 06 起生效） */
  readonly enabled: boolean;
  /** R2 云同步配置（ticket 08 生效；ticket 06 仅占位展示） */
  readonly r2: R2Settings;
  /** 记忆宏名（ticket 15 生效；默认建议 {{memoryContext}}，用户可直接粘贴进提示词预设） */
  readonly macroName: string;
  /** 记忆宏输出上限（字符，ticket 15；超出从尾部截断并附标记；默认 2000） */
  readonly macroLimit: number;
  /** 对话文件镜像（ticket 16 生效） */
  readonly mirror: ChatMirrorSettings;
}

/** extension_settings 命名空间键（ST 全局设置对象上的插件私有键，不与其他扩展冲突） */
export const SETTINGS_KEY = "steMemory";

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: true,
  r2: { accountId: "", accessKeyId: "", secretAccessKey: "", bucket: "" },
  macroName: "{{memoryContext}}",
  macroLimit: 2000,
  mirror: { enabled: true, includeHistory: true },
};

/** 设置存储端口：read 每次重取（宿主读 ST 全局对象，保证拿到最新持久化值） */
export interface SettingsStore {
  read(): PluginSettings;
  write(settings: PluginSettings): void;
}

/**
 * 把持久化的原始值合并进默认值：缺失键补默认、类型不符的键回退默认，
 * 未知键不进入结果。损坏/半旧数据（来自旧版本插件或手改）不会让运行时崩溃。
 */
export function mergeSettings(raw: unknown): PluginSettings {
  const source = isRecord(raw) ? raw : {};
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled,
    r2: mergeR2(source.r2),
    macroName: typeof source.macroName === "string" ? source.macroName : DEFAULT_SETTINGS.macroName,
    macroLimit:
      typeof source.macroLimit === "number" && Number.isFinite(source.macroLimit) && source.macroLimit >= 0
        ? source.macroLimit
        : DEFAULT_SETTINGS.macroLimit,
    mirror: mergeMirror(source.mirror),
  };
}

/** R2 四项配置全部非空 = 已配置（面板同步状态占位的判定；ticket 08 接入真实状态） */
export function isR2Configured(settings: PluginSettings): boolean {
  const r2 = settings.r2;
  return (
    r2.accountId.trim() !== "" &&
    r2.accessKeyId.trim() !== "" &&
    r2.secretAccessKey.trim() !== "" &&
    r2.bucket.trim() !== ""
  );
}

function mergeR2(raw: unknown): R2Settings {
  const source = isRecord(raw) ? raw : {};
  const defaults = DEFAULT_SETTINGS.r2;
  return {
    accountId: typeof source.accountId === "string" ? source.accountId : defaults.accountId,
    accessKeyId: typeof source.accessKeyId === "string" ? source.accessKeyId : defaults.accessKeyId,
    secretAccessKey:
      typeof source.secretAccessKey === "string"
        ? source.secretAccessKey
        : defaults.secretAccessKey,
    bucket: typeof source.bucket === "string" ? source.bucket : defaults.bucket,
  };
}

function mergeMirror(raw: unknown): ChatMirrorSettings {
  const source = isRecord(raw) ? raw : {};
  const defaults = DEFAULT_SETTINGS.mirror;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    includeHistory:
      typeof source.includeHistory === "boolean" ? source.includeHistory : defaults.includeHistory,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
