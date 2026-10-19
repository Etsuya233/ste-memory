/**
 * 面板状态机（纯逻辑层 seam 的一部分）：开关、抽屉导航与当前区的状态。
 * 宿主（PanelShell）只做 DOM 映射：状态变化 → 同步面板 class / 抽屉 class /
 * 导航项高亮 / 渲染对应区块。测试直接驱动本模型，不碰 ST DOM。
 */

export type PanelTab = "tables" | "records" | "tasks" | "query" | "logs" | "settings";

/** 导航固定顺序（spec UI 形态：表格/记录/任务/问答/日志/设置；问答 = ticket 20） */
export const PANEL_TABS: readonly PanelTab[] = [
  "tables",
  "records",
  "tasks",
  "query",
  "logs",
  "settings",
];

/** 区显示名（顶栏标题/抽屉导航项共用） */
export const PANEL_TAB_LABELS: Readonly<Record<PanelTab, string>> = {
  tables: "表格",
  records: "记录",
  tasks: "任务",
  query: "问答",
  logs: "日志",
  settings: "设置",
};

export interface PanelState {
  readonly open: boolean;
  /** 侧边抽屉导航是否展开（仅面板打开时有意义） */
  readonly navOpen: boolean;
  readonly tab: PanelTab;
}

export class PanelModel {
  #state: PanelState = { open: false, navOpen: false, tab: "tables" };
  readonly #listeners = new Set<() => void>();

  getState(): PanelState {
    return this.#state;
  }

  /** 顶部按钮点击：开 ↔ 关；收起面板时同时收起抽屉 */
  toggle(): void {
    const open = !this.#state.open;
    this.#set({ ...this.#state, open, navOpen: open ? this.#state.navOpen : false });
  }

  open(): void {
    this.#set({ ...this.#state, open: true });
  }

  /** 收起面板（抽屉一并收起，避免下次打开残留遮罩） */
  close(): void {
    this.#set({ ...this.#state, open: false, navOpen: false });
  }

  setTab(tab: PanelTab): void {
    if (tab === this.#state.tab) return;
    this.#set({ ...this.#state, tab });
  }

  /** ☰ 按钮：展开 ↔ 收起抽屉 */
  toggleNav(): void {
    this.setNav(!this.#state.navOpen);
  }

  setNav(open: boolean): void {
    if (open === this.#state.navOpen) return;
    this.#set({ ...this.#state, navOpen: open });
  }

  /** 选中导航项 / 点遮罩 / Esc：收起抽屉（面板保持打开） */
  closeNav(): void {
    this.setNav(false);
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
