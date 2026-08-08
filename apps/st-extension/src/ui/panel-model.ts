/**
 * 面板状态机（纯逻辑层 seam 的一部分）：开关与底部 Tab 的当前状态。
 * 宿主（StPanelHost）只做 DOM 映射：状态变化 → 同步抽屉 class / Tab 高亮 /
 * 渲染对应区块。测试直接驱动本模型，不碰 ST DOM。
 */

export type PanelTab = "tables" | "records" | "tasks" | "settings";

/** 底部 Tab 固定顺序（spec UI 形态：表格/记录/任务/设置） */
export const PANEL_TABS: readonly PanelTab[] = ["tables", "records", "tasks", "settings"];

/** Tab 显示名（宿主渲染 tabbar 用） */
export const PANEL_TAB_LABELS: Readonly<Record<PanelTab, string>> = {
  tables: "表格",
  records: "记录",
  tasks: "任务",
  settings: "设置",
};

export interface PanelState {
  readonly open: boolean;
  readonly tab: PanelTab;
}

export class PanelModel {
  #state: PanelState = { open: false, tab: "tables" };
  readonly #listeners = new Set<() => void>();

  getState(): PanelState {
    return this.#state;
  }

  /** 顶部按钮点击：开 ↔ 关 */
  toggle(): void {
    this.#set({ ...this.#state, open: !this.#state.open });
  }

  open(): void {
    this.#set({ ...this.#state, open: true });
  }

  close(): void {
    this.#set({ ...this.#state, open: false });
  }

  setTab(tab: PanelTab): void {
    if (tab === this.#state.tab) return;
    this.#set({ ...this.#state, tab });
  }

  /** 订阅状态变化（面板渲染）；返回退订函数 */
  onStateChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #set(next: PanelState): void {
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
}
