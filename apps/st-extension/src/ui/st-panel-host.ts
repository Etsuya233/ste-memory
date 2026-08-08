import type {
  MemoryFieldId,
  MemoryTableId,
} from "@ste-memory/core/memory";
import type { SteMemoryRuntime } from "../runtime.ts";
import type { PluginSettings } from "../settings/plugin-settings.ts";
import type { SpaceContextStatus } from "../space-binding/chat-space-manager.ts";
import { PLUGIN_DISPLAY_NAME } from "../constants.ts";
import { PANEL_TAB_LABELS, PANEL_TABS, PanelModel, type PanelTab } from "./panel-model.ts";
import { buildSpaceInfo, runtimeStatusLabel } from "./space-info.ts";
import {
  buildTableListViewModel,
  type TableListItemViewModel,
} from "./table-list-model.ts";

/** ST 全局 toastr（jquery-toast-plugin，ST 自带）；缺失时降级 console。 */
declare global {
  var toastr:
    | {
        error(message: string, title?: string): void;
        warning(message: string, title?: string): void;
      }
    | undefined;
}

/**
 * 面板 DOM 宿主（ST 侧薄层；spec 测试决策：ST DOM 不测——所有判定在纯模块
 * panel-model / table-list-model / space-info，这里只做 DOM 映射与事件接线）：
 *
 * - 顶部工具栏按钮插入 `#top-settings-holder`（ST 顶部栏；找不到时兜底 body）；
 * - 面板 = 自绘 `aside.stm-panel`（移动端全屏底部抽屉 / 桌面浮动面板，纯 CSS
 *   媒体查询区分，不依赖 ST 主题变量）；
 * - 底部 Tab（表格/记录/任务/设置）：记录与任务为占位（ticket 11/14）；
 *   表格 Tab 展示当前空间表格列表 + 表格/字段启停开关（落库）；
 *   设置 Tab：插件总开关（经 extensionSettings 持久化）、版本与运行状态、
 *   R2 配置与记忆宏名占位（ticket 08/15 开放）；
 * - 头部空间信息（名称 + 同步状态占位）随 manager 状态变化重渲染。
 */

export function mountPanel(runtime: SteMemoryRuntime): void {
  // 非浏览器环境（Node 测试）不挂 DOM
  if (typeof document === "undefined") return;
  const host = new StPanelHost(runtime);
  host.mount();
}

/** 活动空间状态（表格列表只在该状态下渲染） */
type ActiveStatus = Extract<SpaceContextStatus, { kind: "active" }>;

function activeStatus(status: SpaceContextStatus | undefined): ActiveStatus | undefined {
  return status?.kind === "active" ? status : undefined;
}

class StPanelHost {
  readonly #runtime: SteMemoryRuntime;
  readonly #model = new PanelModel();
  /** 展开字段列表的表格 id 集合（重渲染保持） */
  readonly #expanded = new Set<MemoryTableId>();
  #autoExpandedFirst = false;
  /** 渲染序号：异步渲染完成后若已过期（期间又触发渲染）则丢弃 */
  #renderToken = 0;
  #button: HTMLElement | undefined;
  #panel: HTMLElement | undefined;

  constructor(runtime: SteMemoryRuntime) {
    this.#runtime = runtime;
  }

  mount(): void {
    this.#button = this.#createToolbarButton();
    this.#panel = this.#createPanel();
    (document.getElementById("top-settings-holder") ?? document.body).appendChild(this.#button);
    document.body.appendChild(this.#panel);

    this.#button.addEventListener("click", () => this.#model.toggle());
    this.#panel.addEventListener("click", (event) => this.#onPanelClick(event));
    this.#panel.addEventListener("change", (event) => this.#onPanelChange(event));
    this.#model.onStateChange(() => this.#syncFromModel());
    this.#runtime.manager.onStatusChange(() => void this.#render());

    this.#syncFromModel();
  }

  // ---- 构建 ----

  #createToolbarButton(): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.className = "stm-toolbar";
    toolbar.innerHTML = `
      <button type="button" class="stm-toolbar-button" aria-label="${PLUGIN_DISPLAY_NAME} 记忆面板" aria-pressed="false">
        <i class="fa-solid fa-book-open" aria-hidden="true"></i>
      </button>`;
    return toolbar;
  }

  #createPanel(): HTMLElement {
    const panel = document.createElement("aside");
    panel.className = "stm-panel";
    panel.id = "stm-panel";
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <header class="stm-panel-header"></header>
      <nav class="stm-tabbar" role="tablist" aria-label="${PLUGIN_DISPLAY_NAME} 面板">
        ${PANEL_TABS.map(
          (tab) => `
          <button type="button" class="stm-tab" role="tab" data-tab="${tab}" data-action="tab" aria-selected="false">
            ${PANEL_TAB_LABELS[tab]}
          </button>`,
        ).join("")}
      </nav>
      <main class="stm-panel-body">
        <section class="stm-tab-section" data-stm-section="tables" role="tabpanel"></section>
        <section class="stm-tab-section" data-stm-section="records" role="tabpanel">
          ${emptyStateHtml("记录视图即将开放", "在这里按表格查看记忆记录、字段值与证据楼层")}
        </section>
        <section class="stm-tab-section" data-stm-section="tasks" role="tabpanel">
          ${emptyStateHtml("任务状态即将开放", "在这里手动指定楼层范围触发填表任务")}
        </section>
        <section class="stm-tab-section" data-stm-section="settings" role="tabpanel"></section>
      </main>`;
    return panel;
  }

  // ---- 状态 → DOM ----

  #syncFromModel(): void {
    const state = this.#model.getState();
    const button = this.#button?.querySelector<HTMLElement>(".stm-toolbar-button");
    const panel = this.#panel;
    if (!button || !panel) return;

    button.setAttribute("aria-pressed", String(state.open));
    panel.classList.toggle("stm-panel--open", state.open);
    panel.setAttribute("aria-hidden", String(!state.open));
    for (const tab of PANEL_TABS) {
      const selected = tab === state.tab;
      panel
        .querySelector<HTMLElement>(`.stm-tab[data-tab="${tab}"]`)
        ?.setAttribute("aria-selected", String(selected));
      this.#section(tab)?.classList.toggle("stm-tab-section--active", selected);
    }
    void this.#render();
  }

  async #render(): Promise<void> {
    const token = ++this.#renderToken;
    const status = this.#runtime.manager.getStatus();
    const settings = this.#runtime.settings.read();
    this.#renderHeader(status, settings);
    const tab = this.#model.getState().tab;
    const section = this.#section(tab);
    if (!section) return;
    if (tab === "tables") {
      await this.#renderTables(section, status, settings, token);
    } else if (tab === "settings") {
      this.#renderSettings(section, status, settings);
    }
    if (token !== this.#renderToken) return; // 期间有更新：丢弃本次陈旧渲染
  }

  #renderHeader(status: SpaceContextStatus | undefined, settings: PluginSettings): void {
    const header = this.#panel?.querySelector<HTMLElement>(".stm-panel-header");
    if (!header) return;
    const info = buildSpaceInfo(status, settings);
    header.innerHTML = `
      <div class="stm-space-info">
        <div class="stm-space-title">${escapeHtml(info.title)}</div>
        ${info.detail ? `<div class="stm-space-status">${escapeHtml(info.detail)}</div>` : ""}
      </div>
      <button type="button" class="stm-panel-close" data-action="close-panel" aria-label="收起面板">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>`;
  }

  async #renderTables(
    section: HTMLElement,
    status: SpaceContextStatus | undefined,
    settings: PluginSettings,
    token: number,
  ): Promise<void> {
    if (!settings.enabled) {
      section.innerHTML = emptyStateHtml(
        "插件已停用",
        "在设置中重新启用后恢复表格展示与同步",
      );
      return;
    }
    const active = activeStatus(status);
    if (!active) {
      section.innerHTML = emptyStateHtml(
        status && status.kind !== "active" ? status.humanMsg : "正在加载…",
        "切换到已保存的对话后自动恢复",
      );
      return;
    }
    const tables = await this.#runtime.tables.list(active.space.id);
    const fieldLists = await Promise.all(
      tables.map((table) => this.#runtime.fields.list(active.space.id, table.id)),
    );
    if (token !== this.#renderToken) return; // 异步加载期间已过期：丢弃
    const fieldsByTable = new Map(tables.map((table, index) => [table.id, fieldLists[index]!]));
    const viewModel = buildTableListViewModel(tables, fieldsByTable);
    this.#pruneExpanded(viewModel);
    if (!this.#autoExpandedFirst && viewModel.length > 0) {
      this.#autoExpandedFirst = true;
      this.#expanded.add(viewModel[0]!.id);
    }
    section.innerHTML = this.#tableListHtml(viewModel);
  }

  #renderSettings(
    section: HTMLElement,
    status: SpaceContextStatus | undefined,
    settings: PluginSettings,
  ): void {
    const r2 = settings.r2;
    section.innerHTML = `
      <div class="stm-setting-group">
        <div class="stm-setting-row">
          <div class="stm-setting-label">
            <div class="stm-setting-name">插件总开关</div>
            <div class="stm-setting-hint">关闭后暂停空间绑定与同步；面板仍可打开重新启用</div>
          </div>
          <label class="stm-switch">
            <input type="checkbox" data-action="toggle-plugin" ${settings.enabled ? "checked" : ""}>
            <span class="stm-switch-track" aria-hidden="true"></span>
          </label>
        </div>
      </div>
      <div class="stm-setting-group">
        <div class="stm-setting-group-title">版本与运行状态</div>
        <div class="stm-setting-row">
          <div class="stm-setting-name">版本</div>
          <div class="stm-setting-value stm-mono">v${escapeHtml(this.#runtime.version)}</div>
        </div>
        <div class="stm-setting-row">
          <div class="stm-setting-name">运行状态</div>
          <div class="stm-setting-value">${escapeHtml(runtimeStatusLabel(status))}</div>
        </div>
      </div>
      <div class="stm-setting-group">
        <div class="stm-setting-group-title">R2 云同步（后续版本开放）</div>
        <input class="stm-input" type="text" data-stm-field="r2-account-id" placeholder="Account ID" value="${escapeHtml(r2.accountId)}" disabled>
        <input class="stm-input" type="text" data-stm-field="r2-access-key-id" placeholder="Access Key ID" value="${escapeHtml(r2.accessKeyId)}" disabled>
        <input class="stm-input" type="password" data-stm-field="r2-secret-access-key" placeholder="Secret Access Key" value="${escapeHtml(r2.secretAccessKey)}" disabled>
        <input class="stm-input" type="text" data-stm-field="r2-bucket" placeholder="Bucket" value="${escapeHtml(r2.bucket)}" disabled>
        <div class="stm-setting-hint">配置后记忆数据将自动备份到 Cloudflare R2（即将开放）</div>
      </div>
      <div class="stm-setting-group">
        <div class="stm-setting-group-title">记忆宏（后续版本开放）</div>
        <input class="stm-input" type="text" data-stm-field="macro-name" value="${escapeHtml(settings.macroName)}" disabled>
        <div class="stm-setting-hint">宏名可自定义；放入提示词预设后，生成时展开当前记忆上下文</div>
      </div>`;
  }

  #tableListHtml(viewModel: readonly TableListItemViewModel[]): string {
    if (viewModel.length === 0) {
      return emptyStateHtml("还没有记忆表格", "当前空间的表格会出现在这里");
    }
    const rows = viewModel
      .map((table) => {
        const expanded = this.#expanded.has(table.id);
        const kindLabel = table.kind === "system" ? "系统表" : "自定义";
        const fieldCountText =
          table.fields.length === 0
            ? "无字段"
            : `${table.enabledFieldCount}/${table.fields.length} 字段启用`;
        const fieldsHtml =
          expanded && table.fields.length > 0
            ? `<ul class="stm-field-list">${table.fields
                .map(
                  (field) => `
                <li class="stm-field-row">
                  <div class="stm-field-info">
                    <div class="stm-field-name">${escapeHtml(field.name)}${field.required ? '<span class="stm-field-required" title="必填">*</span>' : ""}</div>
                    <div class="stm-field-tag">${escapeHtml(field.key)} · ${escapeHtml(field.typeLabel)}</div>
                  </div>
                  <label class="stm-switch">
                    <input type="checkbox" data-action="toggle-field" data-table-id="${table.id}" data-field-id="${field.id}" ${field.enabled ? "checked" : ""}>
                    <span class="stm-switch-track" aria-hidden="true"></span>
                  </label>
                </li>`,
                )
                .join("")}</ul>`
            : "";
        return `
          <li class="stm-table-card">
            <div class="stm-table-row">
              <button type="button" class="stm-expand" data-action="expand-table" data-table-id="${table.id}" aria-expanded="${expanded}" aria-label="${expanded ? "收起字段" : "展开字段"}">
                <i class="fa-solid ${expanded ? "fa-chevron-up" : "fa-chevron-down"}" aria-hidden="true"></i>
              </button>
              <div class="stm-table-row-main">
                <div class="stm-table-name">${escapeHtml(table.name)}<span class="stm-table-kind">${kindLabel}</span></div>
                <div class="stm-table-meta">${escapeHtml(table.key)} · ${fieldCountText}</div>
              </div>
              <label class="stm-switch">
                <input type="checkbox" data-action="toggle-table" data-table-id="${table.id}" ${table.enabled ? "checked" : ""}>
                <span class="stm-switch-track" aria-hidden="true"></span>
              </label>
            </div>
            ${fieldsHtml}
          </li>`;
      })
      .join("");
    return `<ul class="stm-table-list">${rows}</ul>`;
  }

  #pruneExpanded(viewModel: readonly TableListItemViewModel[]): void {
    const ids = new Set(viewModel.map((table) => table.id));
    for (const id of [...this.#expanded]) {
      if (!ids.has(id)) this.#expanded.delete(id); // 切空间后旧表格 id 失效
    }
  }

  // ---- 事件 → 动作 ----

  #onPanelClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target || !this.#panel?.contains(target)) return;
    const action = target.dataset.action;
    if (action === "close-panel") {
      this.#model.close();
    } else if (action === "tab") {
      this.#model.setTab(target.dataset.tab as PanelTab);
    } else if (action === "expand-table") {
      const tableId = target.dataset.tableId as MemoryTableId;
      if (this.#expanded.has(tableId)) {
        this.#expanded.delete(tableId);
      } else {
        this.#expanded.add(tableId);
      }
      void this.#render();
    }
  }

  #onPanelChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const action = input.dataset?.action;
    if (action === "toggle-table") {
      void this.#onToggleTable(input.dataset.tableId as MemoryTableId, input.checked);
    } else if (action === "toggle-field") {
      void this.#onToggleField(
        input.dataset.tableId as MemoryTableId,
        input.dataset.fieldId as MemoryFieldId,
        input.checked,
      );
    } else if (action === "toggle-plugin") {
      this.#onTogglePlugin(input.checked);
    }
  }

  async #onToggleTable(tableId: MemoryTableId, enabled: boolean): Promise<void> {
    const active = this.#requireActive();
    if (!active) return;
    try {
      await this.#runtime.tables.update(active.space.id, tableId, { enabled });
    } catch (error) {
      this.#reportError(error);
    }
    void this.#render();
  }

  async #onToggleField(
    tableId: MemoryTableId,
    fieldId: MemoryFieldId,
    enabled: boolean,
  ): Promise<void> {
    const active = this.#requireActive();
    if (!active) return;
    try {
      const result = await this.#runtime.fields.update(
        active.space.id,
        tableId,
        fieldId,
        { enabled },
      );
      if (result && result.warnings.length > 0) {
        this.#reportWarning(result.warnings.join("；"));
      }
    } catch (error) {
      this.#reportError(error);
    }
    void this.#render();
  }

  #onTogglePlugin(enabled: boolean): void {
    const settings = this.#runtime.settings.read();
    this.#runtime.settings.write({ ...settings, enabled });
    if (enabled) {
      // 重新启用立即恢复空间同步（关闭期间 CHAT_CHANGED 被门控跳过）
      void this.#runtime.manager.syncToCurrentChat().catch((error) => this.#reportError(error));
    }
    void this.#render();
  }

  // ---- 工具 ----

  #requireActive(): ActiveStatus | undefined {
    return activeStatus(this.#runtime.manager.getStatus());
  }

  #section(tab: PanelTab): HTMLElement | null {
    return this.#panel?.querySelector<HTMLElement>(`[data-stm-section="${tab}"]`) ?? null;
  }

  #reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof toastr !== "undefined") {
      toastr.error(message, PLUGIN_DISPLAY_NAME);
    } else {
      console.error(`[${PLUGIN_DISPLAY_NAME}]`, error);
    }
  }

  #reportWarning(message: string): void {
    if (typeof toastr !== "undefined") {
      toastr.warning(message, PLUGIN_DISPLAY_NAME);
    } else {
      console.warn(`[${PLUGIN_DISPLAY_NAME}]`, message);
    }
  }
}

function emptyStateHtml(title: string, hint: string): string {
  return `
    <div class="stm-empty">
      <div class="stm-empty-title">${escapeHtml(title)}</div>
      <div class="stm-empty-hint">${escapeHtml(hint)}</div>
    </div>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
