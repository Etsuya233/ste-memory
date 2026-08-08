/**
 * 面板 React 组件层（ADR 0005：UI 渲染层采用 React，随 esbuild 打进单文件 bundle）。
 *
 * 纯逻辑 seam 不变：状态机/视图模型/文案仍在 panel-model / table-list-model /
 * space-info（有测试兜底），组件只做「状态 → DOM」投影与事件接线。ST DOM 不测的
 * 测试决策不变，组件层用 react-dom/server renderToString 冒烟（无 jsdom）。
 *
 * DOM 结构与类名是验收脚本（docs/playwright-st-extension/verify-ui-shell.mjs）的
 * 契约：改动必须同步改脚本。data-action / data-stm-field 属性保留（脚本按它们
 * 定位元素），行为全部走 React 事件。
 */
import type { MemoryFieldId, MemoryTableId } from "@ste-memory/core/memory";
import {
  createBackupFile,
  parseBackupFile,
  serializeBackupFile,
} from "@ste-memory/core/memory/export";
import type { MemoryBackupFile } from "@ste-memory/core/memory/export";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PLUGIN_DISPLAY_NAME } from "../constants.ts";
import type { CloudSyncStatus } from "../cloud/sync-coordinator.ts";
import type { SteMemoryRuntime } from "../runtime.ts";
import {
  isR2Configured,
  type PluginSettings,
  type R2Settings,
  type SettingsStore,
} from "../settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import { PANEL_TAB_LABELS, PANEL_TABS, type PanelModel } from "./panel-model.ts";
import {
  buildSpaceInfo,
  formatSyncTime,
  runtimeStatusLabel,
  syncStatusSummary,
} from "./space-info.ts";
import { buildTableListViewModel, type TableListItemViewModel } from "./table-list-model.ts";

/** ST 全局 toastr（jquery-toast-plugin，ST 自带）；缺失时降级 console。 */
declare global {
  var toastr:
    | {
        error(message: string, title?: string): void;
        warning(message: string, title?: string): void;
        success(message: string, title?: string): void;
      }
    | undefined;
}

/**
 * 面板组件端口：组件只依赖运行时子集（测试注入 fake 用），完整 SteMemoryRuntime
 * 结构满足该端口，组合根直接传入。
 */
export interface PanelRuntime {
  readonly manager: Pick<
    SteMemoryRuntime["manager"],
    "getStatus" | "onStatusChange" | "syncToCurrentChat"
  >;
  readonly tables: Pick<SteMemoryRuntime["tables"], "list" | "update">;
  readonly fields: Pick<SteMemoryRuntime["fields"], "list" | "update">;
  /** 全库备份（导出读快照 / 导入整体还原，ticket 07） */
  readonly backup: Pick<SteMemoryRuntime["backup"], "loadSnapshot" | "restoreSnapshot">;
  /** 云同步（ticket 08）：状态订阅 + 立即同步 + 设置变化重新评估 */
  readonly sync: Pick<
    SteMemoryRuntime["sync"],
    "getStatus" | "onStatusChange" | "syncNow" | "kick"
  >;
  readonly settings: SettingsStore;
  readonly version: string;
}

/** 活动空间状态（表格列表只在该状态下渲染） */
type ActiveStatus = Extract<SpaceContextStatus, { kind: "active" }>;

// ---- 工具 ----

function activeStatus(status: SpaceContextStatus | undefined): ActiveStatus | undefined {
  return status?.kind === "active" ? status : undefined;
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof toastr !== "undefined") {
    toastr.error(message, PLUGIN_DISPLAY_NAME);
  } else {
    console.error(`[${PLUGIN_DISPLAY_NAME}]`, error);
  }
}

function reportWarning(message: string): void {
  if (typeof toastr !== "undefined") {
    toastr.warning(message, PLUGIN_DISPLAY_NAME);
  } else {
    console.warn(`[${PLUGIN_DISPLAY_NAME}]`, message);
  }
}

function reportSuccess(message: string): void {
  if (typeof toastr !== "undefined") {
    toastr.success(message, PLUGIN_DISPLAY_NAME);
  } else {
    console.info(`[${PLUGIN_DISPLAY_NAME}]`, message);
  }
}

/** 下载文本文件（导出备份）：Blob + 临时 object URL，触发后即释放。 */
function downloadTextFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** 备份文件名：ste-memory-backup-<导出日期>.json（日期取信封 exportedAt）。 */
function backupFilename(exportedAt: string): string {
  return `ste-memory-backup-${exportedAt.slice(0, 10)}.json`;
}

function Placeholder(props: { readonly title: string; readonly hint: string }) {
  return (
    <div className="stm-empty">
      <div className="stm-empty-title">{props.title}</div>
      <div className="stm-empty-hint">{props.hint}</div>
    </div>
  );
}

// ---- 顶部工具栏按钮 ----

export function ToolbarButton(props: { readonly model: PanelModel }) {
  const state = useSyncExternalStore(
    (listener) => props.model.onStateChange(listener),
    () => props.model.getState(),
    () => props.model.getState(),
  );
  return (
    <button
      type="button"
      className="stm-toolbar-button"
      aria-label={`${PLUGIN_DISPLAY_NAME} 记忆面板`}
      aria-pressed={state.open}
      onClick={() => props.model.toggle()}
    >
      <i className="fa-solid fa-book-open" aria-hidden="true"></i>
    </button>
  );
}

// ---- 面板骨架 ----

export function PanelShell(props: { readonly runtime: PanelRuntime; readonly model: PanelModel }) {
  const state = useSyncExternalStore(
    (listener) => props.model.onStateChange(listener),
    () => props.model.getState(),
    () => props.model.getState(),
  );
  const status = useSyncExternalStore(
    (listener) => props.runtime.manager.onStatusChange(listener),
    () => props.runtime.manager.getStatus(),
    () => props.runtime.manager.getStatus(),
  );
  const syncStatus = useSyncExternalStore(
    (listener) => props.runtime.sync.onStatusChange(listener),
    () => props.runtime.sync.getStatus(),
    () => props.runtime.sync.getStatus(),
  );
  // 设置只经本面板的开关写入（唯一写入口），组件本地 state 即最新值
  const [settings, setSettings] = useState<PluginSettings>(() => props.runtime.settings.read());

  const info = buildSpaceInfo(status, settings, syncStatus);
  // 数据版本：导入备份等整库变更后自增，驱动表格列表等依赖数据的区块重取
  const [dataVersion, setDataVersion] = useState(0);
  return (
    <aside
      id="stm-panel"
      className={state.open ? "stm-panel stm-panel--open" : "stm-panel"}
      aria-hidden={!state.open}
    >
      <header className="stm-panel-header">
        <div className="stm-space-info">
          <div className="stm-space-title">{info.title}</div>
          {info.detail ? <div className="stm-space-status">{info.detail}</div> : null}
        </div>
        <button
          type="button"
          className="stm-panel-close"
          data-action="close-panel"
          aria-label="收起面板"
          onClick={() => props.model.close()}
        >
          <i className="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </header>
      <nav className="stm-tabbar" role="tablist" aria-label={`${PLUGIN_DISPLAY_NAME} 面板`}>
        {PANEL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className="stm-tab"
            role="tab"
            data-tab={tab}
            data-action="tab"
            aria-selected={tab === state.tab}
            onClick={() => props.model.setTab(tab)}
          >
            {PANEL_TAB_LABELS[tab]}
          </button>
        ))}
      </nav>
      <main className="stm-panel-body">
        {state.tab === "tables" && (
          <section className="stm-tab-section" data-stm-section="tables" role="tabpanel">
            <TablesTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              dataVersion={dataVersion}
            />
          </section>
        )}
        {state.tab === "records" && (
          <section className="stm-tab-section" data-stm-section="records" role="tabpanel">
            <Placeholder
              title="记录视图即将开放"
              hint="在这里按表格查看记忆记录、字段值与证据楼层"
            />
          </section>
        )}
        {state.tab === "tasks" && (
          <section className="stm-tab-section" data-stm-section="tasks" role="tabpanel">
            <Placeholder title="任务状态即将开放" hint="在这里手动指定楼层范围触发填表任务" />
          </section>
        )}
        {state.tab === "settings" && (
          <section className="stm-tab-section" data-stm-section="settings" role="tabpanel">
            <SettingsTab
              runtime={props.runtime}
              status={status}
              settings={settings}
              syncStatus={syncStatus}
              onSettingsChange={setSettings}
              onDataChanged={() => setDataVersion((version) => version + 1)}
            />
          </section>
        )}
      </main>
    </aside>
  );
}

// ---- 表格列表 Tab ----

function TablesTab(props: {
  readonly runtime: PanelRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 整库数据版本（导入备份后自增，驱动重取） */
  readonly dataVersion: number;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<MemoryTableId>>(new Set());
  const [tables, setTables] = useState<readonly TableListItemViewModel[] | undefined>(undefined);
  // 变更后重新拉取（Dexie 是事实源；重渲染永远基于最新数据）
  const [reloadKey, setReloadKey] = useState(0);
  // 首个表格只自动展开一次（跨空间不重复展开）
  const autoExpandedRef = useRef(false);

  const active = activeStatus(props.status);
  const spaceId = active?.space.id;

  useEffect(() => {
    if (!spaceId) {
      setTables(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await props.runtime.tables.list(spaceId);
        const fieldLists = await Promise.all(
          list.map((table) => props.runtime.fields.list(spaceId, table.id)),
        );
        if (cancelled) return;
        const fieldsByTable = new Map(list.map((table, index) => [table.id, fieldLists[index]!]));
        const viewModel = buildTableListViewModel(list, fieldsByTable);
        // 切空间后旧表格 id 失效；首个表格只自动展开一次
        const validIds = new Set(viewModel.map((table) => table.id));
        setExpanded((prev) => {
          const next = new Set([...prev].filter((id) => validIds.has(id)));
          if (!autoExpandedRef.current && viewModel.length > 0) next.add(viewModel[0]!.id);
          return next;
        });
        autoExpandedRef.current = true;
        setTables(viewModel);
      } catch (error) {
        if (!cancelled) reportError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.runtime, spaceId, reloadKey, props.dataVersion]);

  if (!props.settings.enabled) {
    return <Placeholder title="插件已停用" hint="在设置中重新启用后恢复表格展示与同步" />;
  }
  if (!active) {
    return (
      <Placeholder
        title={props.status && props.status.kind !== "active" ? props.status.humanMsg : "正在加载…"}
        hint="切换到已保存的对话后自动恢复"
      />
    );
  }
  // 守卫后的窄化常量：闭包内不依赖 TS 对联合类型收窄的保留
  const currentSpaceId = active.space.id;
  if (tables === undefined) {
    return null; // 首载完成前不渲染（与旧版内联渲染时机一致）
  }
  if (tables.length === 0) {
    return <Placeholder title="还没有记忆表格" hint="当前空间的表格会出现在这里" />;
  }

  async function toggleTable(tableId: MemoryTableId, enabled: boolean): Promise<void> {
    try {
      await props.runtime.tables.update(currentSpaceId, tableId, { enabled });
    } catch (error) {
      reportError(error);
    }
    setReloadKey((key) => key + 1);
  }

  async function toggleField(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    enabled: boolean,
  ): Promise<void> {
    try {
      const result = await props.runtime.fields.update(currentSpaceId, tableId, fieldId, {
        enabled,
      });
      if (result && result.warnings.length > 0) {
        reportWarning(result.warnings.join("；"));
      }
    } catch (error) {
      reportError(error);
    }
    setReloadKey((key) => key + 1);
  }

  function toggleExpand(tableId: MemoryTableId): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) {
        next.delete(tableId);
      } else {
        next.add(tableId);
      }
      return next;
    });
  }

  return (
    <ul className="stm-table-list">
      {tables.map((table) => {
        const isExpanded = expanded.has(table.id);
        const kindLabel = table.kind === "system" ? "系统表" : "自定义";
        const fieldCountText =
          table.fields.length === 0
            ? "无字段"
            : `${table.enabledFieldCount}/${table.fields.length} 字段启用`;
        return (
          <li key={table.id} className="stm-table-card">
            {/* 整行可点击展开/收起（点开关除外；展开按钮 stopPropagation 避免双触发） */}
            <div
              className="stm-table-row"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest(".stm-switch")) return;
                toggleExpand(table.id);
              }}
            >
              <button
                type="button"
                className="stm-expand"
                data-action="expand-table"
                data-table-id={table.id}
                aria-expanded={isExpanded}
                aria-label={isExpanded ? "收起字段" : "展开字段"}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleExpand(table.id);
                }}
              >
                <i
                  className={`fa-solid ${isExpanded ? "fa-chevron-up" : "fa-chevron-down"}`}
                  aria-hidden="true"
                />
              </button>
              <div className="stm-table-row-main">
                <div className="stm-table-name">
                  {table.name}
                  <span className="stm-table-kind">{kindLabel}</span>
                </div>
                <div className="stm-table-meta">
                  {table.key} · {fieldCountText}
                </div>
              </div>
              <label className="stm-switch">
                <input
                  type="checkbox"
                  data-action="toggle-table"
                  data-table-id={table.id}
                  checked={table.enabled}
                  onChange={(event) => void toggleTable(table.id, event.target.checked)}
                />
                <span className="stm-switch-track" aria-hidden="true"></span>
              </label>
            </div>
            {isExpanded && table.fields.length > 0 && (
              <ul className="stm-field-list">
                {table.fields.map((field) => (
                  <li key={field.id} className="stm-field-row">
                    <div className="stm-field-info">
                      <div className="stm-field-name">
                        {field.name}
                        {field.required ? (
                          <span className="stm-field-required" title="必填">
                            *
                          </span>
                        ) : null}
                      </div>
                      <div className="stm-field-tag">
                        {field.key} · {field.typeLabel}
                      </div>
                    </div>
                    <label className="stm-switch">
                      <input
                        type="checkbox"
                        data-action="toggle-field"
                        data-table-id={table.id}
                        data-field-id={field.id}
                        checked={field.enabled}
                        onChange={(event) =>
                          void toggleField(table.id, field.id, event.target.checked)
                        }
                      />
                      <span className="stm-switch-track" aria-hidden="true"></span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---- 设置 Tab ----

function SettingsTab(props: {
  readonly runtime: PanelRuntime;
  readonly status: SpaceContextStatus | undefined;
  readonly settings: PluginSettings;
  /** 云同步状态（ticket 08：最近同步时间、失败提示可见） */
  readonly syncStatus: CloudSyncStatus;
  readonly onSettingsChange: (settings: PluginSettings) => void;
  /** 整库数据变更（导入备份成功）后的通知：触发依赖数据的区块重取 */
  readonly onDataChanged: () => void;
}) {
  const r2 = props.settings.r2;
  const configured = isR2Configured(props.settings);
  // 导入文件输入（按钮触发隐藏 input；重置 value 允许重复选择同一文件）
  const importInputRef = useRef<HTMLInputElement>(null);

  function togglePlugin(enabled: boolean): void {
    const next = { ...props.settings, enabled };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    if (enabled) {
      // 重新启用立即恢复空间同步（关闭期间 CHAT_CHANGED 被门控跳过）
      void props.runtime.manager.syncToCurrentChat().catch(reportError);
    }
  }

  /** 更新单个 R2 配置字段并持久化；配置变化即时生效（协调器 kick 重新评估） */
  function updateR2Field(field: keyof R2Settings, value: string): void {
    const next = { ...props.settings, r2: { ...props.settings.r2, [field]: value } };
    props.runtime.settings.write(next);
    props.onSettingsChange(next);
    void props.runtime.sync.kick().catch(reportError);
  }

  async function syncNow(): Promise<void> {
    try {
      await props.runtime.sync.syncNow();
    } catch (error) {
      reportError(error);
    }
  }

  async function exportBackup(): Promise<void> {
    try {
      const snapshot = await props.runtime.backup.loadSnapshot();
      const file = createBackupFile(snapshot, props.runtime.version, new Date().toISOString());
      downloadTextFile(serializeBackupFile(file), backupFilename(file.exportedAt));
      reportSuccess(`已导出 ${file.data.spaces.length} 个记忆空间`);
    } catch (error) {
      reportError(error);
    }
  }

  async function importBackup(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      reportError(error);
      return;
    }
    // 导入前校验（信封/结构/完整性）：失败报错且不触碰数据库
    let decoded: MemoryBackupFile;
    try {
      decoded = parseBackupFile(text);
    } catch (error) {
      reportError(error);
      return;
    }
    const spaceCount = decoded.data.spaces.length;
    if (!window.confirm(`导入将替换当前全部记忆数据（共 ${spaceCount} 个记忆空间），确定继续？`)) {
      return;
    }
    try {
      // 整体替换原子执行：任一步失败整体回滚，绝不产生半导入状态
      await props.runtime.backup.restoreSnapshot(decoded.data);
      reportSuccess(`已从备份恢复 ${spaceCount} 个记忆空间`);
      props.onDataChanged();
      // 恢复后立即重同步当前对话的空间绑定
      await props.runtime.manager.syncToCurrentChat().catch(reportError);
    } catch (error) {
      reportError(error);
    }
  }

  return (
    <>
      <div className="stm-setting-group">
        <div className="stm-setting-row">
          <div className="stm-setting-label">
            <div className="stm-setting-name">插件总开关</div>
            <div className="stm-setting-hint">关闭后暂停空间绑定与同步；面板仍可打开重新启用</div>
          </div>
          <label className="stm-switch">
            <input
              type="checkbox"
              data-action="toggle-plugin"
              checked={props.settings.enabled}
              onChange={(event) => togglePlugin(event.target.checked)}
            />
            <span className="stm-switch-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
      <div className="stm-setting-group">
        <div className="stm-setting-group-title">版本与运行状态</div>
        <div className="stm-setting-row">
          <div className="stm-setting-name">版本</div>
          <div className="stm-setting-value stm-mono">{`v${props.runtime.version}`}</div>
        </div>
        <div className="stm-setting-row">
          <div className="stm-setting-name">运行状态</div>
          <div className="stm-setting-value">{runtimeStatusLabel(props.status)}</div>
        </div>
      </div>
      <div className="stm-setting-group">
        <div className="stm-setting-group-title">数据备份</div>
        <div className="stm-setting-actions">
          <button
            type="button"
            className="stm-button"
            data-action="export-backup"
            onClick={() => void exportBackup()}
          >
            导出备份
          </button>
          <button
            type="button"
            className="stm-button"
            data-action="import-backup"
            onClick={() => importInputRef.current?.click()}
          >
            导入备份
          </button>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          data-stm-field="import-backup-file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importBackup(file);
            event.target.value = "";
          }}
        />
        <div className="stm-setting-hint">
          导出下载全库 JSON 备份文件；导入前校验文件并整体替换当前数据
        </div>
      </div>
      <div className="stm-setting-group">
        <div className="stm-setting-group-title">云同步（Cloudflare R2）</div>
        <input
          className="stm-input"
          type="text"
          data-stm-field="r2-account-id"
          placeholder="Account ID"
          value={r2.accountId}
          onChange={(event) => updateR2Field("accountId", event.target.value)}
        />
        <input
          className="stm-input"
          type="text"
          data-stm-field="r2-access-key-id"
          placeholder="Access Key ID"
          value={r2.accessKeyId}
          onChange={(event) => updateR2Field("accessKeyId", event.target.value)}
        />
        <input
          className="stm-input"
          type="password"
          data-stm-field="r2-secret-access-key"
          placeholder="Secret Access Key"
          value={r2.secretAccessKey}
          onChange={(event) => updateR2Field("secretAccessKey", event.target.value)}
        />
        <input
          className="stm-input"
          type="text"
          data-stm-field="r2-bucket"
          placeholder="Bucket"
          value={r2.bucket}
          onChange={(event) => updateR2Field("bucket", event.target.value)}
        />
        <div className="stm-setting-hint">
          四项填齐即自动启用：数据变更防抖推送、空库启动自动拉取、较新版本胜出；Bucket
          需配置 CORS（详见插件文档 R2 云同步配置）
        </div>
      </div>
      <div className="stm-setting-group">
        <div className="stm-setting-group-title">同步状态</div>
        <div className="stm-setting-row">
          <div className="stm-setting-name">状态</div>
          <div className="stm-setting-value" data-stm-field="cloud-sync-status">
            {syncStatusSummary(props.syncStatus)}
          </div>
        </div>
        <div className="stm-setting-row">
          <div className="stm-setting-name">最近同步</div>
          <div className="stm-setting-value stm-mono" data-stm-field="cloud-sync-last">
            {(props.syncStatus.kind === "idle" || props.syncStatus.kind === "error") &&
            props.syncStatus.lastSyncAt
              ? formatSyncTime(props.syncStatus.lastSyncAt)
              : "尚未同步"}
          </div>
        </div>
        {props.syncStatus.kind === "error" ? (
          <div className="stm-setting-row">
            <div className="stm-setting-name">失败提示</div>
            <div className="stm-setting-value stm-sync-error" data-stm-field="cloud-sync-error">
              {props.syncStatus.message}
            </div>
          </div>
        ) : null}
        <div className="stm-setting-actions">
          <button
            type="button"
            className="stm-button"
            data-action="sync-now"
            disabled={!configured}
            onClick={() => void syncNow()}
          >
            立即同步
          </button>
        </div>
        <div className="stm-setting-hint">
          断网或配置错误时这里显示失败提示，插件会按退避自动重试
        </div>
      </div>
      <div className="stm-setting-group">
        <div className="stm-setting-group-title">记忆宏（后续版本开放）</div>
        <input
          className="stm-input"
          type="text"
          data-stm-field="macro-name"
          value={props.settings.macroName}
          disabled
        />
        <div className="stm-setting-hint">
          宏名可自定义；放入提示词预设后，生成时展开当前记忆上下文
        </div>
      </div>
    </>
  );
}
