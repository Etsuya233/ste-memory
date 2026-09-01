import { createRoot, type Root } from "react-dom/client";
import type { SteMemoryRuntime } from "../runtime.ts";
import type { EntryPlacement } from "../settings/plugin-settings.ts";
import {
  createEntryPlanStore,
  planEntryMount,
  type EntryMountControllerPort,
  type EntryMountPlan,
} from "./entry-placement.ts";
import { PanelModel } from "./panel-model.ts";
import { PanelShell, ToolbarButton, WandEntry } from "./panel-shell.tsx";
import type { LeaveGuard } from "./record-view.tsx";

/** ST 魔法棒菜单容器 id（extensions.js 的 addExtensionsButtonAndMenu 追加到 body） */
const WAND_MENU_ID = "extensionsMenu";
/** 等待魔法棒菜单的窗口：ST 扩展初始化通常 1~2s 内建好；超时视为不可用 → 回退顶部 */
const WAND_WAIT_TIMEOUT_MS = 15_000;

/**
 * 面板挂载（ST 侧薄层；spec 测试决策：ST DOM 不测）：建三个 React 根——
 * 顶部工具栏按钮（#top-settings-holder，找不到兜底 body）、魔法棒入口项
 * （可选，挂 #extensionsMenu）与面板（aside#stm-panel，挂 body 末尾）。
 * 顶部/魔法棒入口的位置由设置 entryPlacement 经 EntryMountController 决定
 * （状态全部在 PanelModel / manager / settings 存储，组件只做投影；
 * 挂载决策纯逻辑在 entry-placement.ts 已单测）；非浏览器环境（Node 测试）直接跳过。
 */
export function mountPanel(runtime: SteMemoryRuntime): void {
  if (typeof document === "undefined") return;
  const model = new PanelModel();
  // 顶部按钮与面板共享同一离开守卫槽（记录 Tab 注册；收面板时按钮也先确认）
  const leaveGuardRef: { current: LeaveGuard | null } = { current: null };
  const controller = new EntryMountController({
    model,
    leaveGuardRef,
    readPlacement: () => runtime.settings.read().entryPlacement,
  });
  controller.refresh();

  const panelHost = document.createElement("div");
  panelHost.className = "stm-panel-host";
  document.body.appendChild(panelHost);
  const panelRoot: Root = createRoot(panelHost);
  panelRoot.render(
    <PanelShell
      runtime={{ ...runtime, st: runtime.adapter, entryMount: controller }}
      model={model}
      leaveGuardRef={leaveGuardRef}
    />,
  );
}

/**
 * 面板入口挂载控制器（ST DOM 侧；决策在 entry-placement.ts 单测，DOM 行为人工验收）：
 * 按设置解析挂载目标并热切换——顶部按钮即挂即收；魔法棒项在 #extensionsMenu 出现后
 * 才挂，等待窗口（WAND_WAIT_TIMEOUT_MS）内未出现则保持回退计划（顶部落位，
 * 设置分组如实显示）；设置变更经 replan 重新解析（菜单已就绪则直接挂魔法棒）。
 */
class EntryMountController implements EntryMountControllerPort {
  readonly #model: PanelModel;
  readonly #leaveGuardRef: { current: LeaveGuard | null };
  readonly #readPlacement: () => EntryPlacement;
  readonly #planStore = createEntryPlanStore();
  #toolbarHost: HTMLDivElement | null = null;
  #toolbarRoot: Root | null = null;
  #wandHost: HTMLDivElement | null = null;
  #wandRoot: Root | null = null;
  #wandObserver: MutationObserver | null = null;
  #wandTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: {
    readonly model: PanelModel;
    readonly leaveGuardRef: { current: LeaveGuard | null };
    readonly readPlacement: () => EntryPlacement;
  }) {
    this.#model = deps.model;
    this.#leaveGuardRef = deps.leaveGuardRef;
    this.#readPlacement = deps.readPlacement;
  }

  getPlan(): EntryMountPlan {
    return this.#planStore.getPlan();
  }

  onPlanChange(listener: () => void): () => void {
    return this.#planStore.onPlanChange(listener);
  }

  /** 设置变更后重新解析并热切换挂载点（终止进行中的魔法棒等待） */
  replan(): void {
    this.refresh();
  }

  /** 初次挂载与 replan 共用：重新探测魔法棒菜单就绪度并应用计划 */
  refresh(): void {
    this.#stopWandWaiting();
    const wandReady = findWandMenu() !== null;
    const plan = planEntryMount(this.#readPlacement(), wandReady);
    this.#applyPlan(plan);
    if (plan.wand && !wandReady) this.#startWandWaiting();
  }

  #applyPlan(plan: EntryMountPlan): void {
    // 先发布计划（设置分组读回退标记），再做 DOM 挂载/卸载
    this.#planStore.setPlan(plan);
    this.#applyTop(plan);
    this.#applyWand(plan);
  }

  #applyTop(plan: EntryMountPlan): void {
    if (plan.top) {
      if (this.#toolbarRoot) return;
      this.#toolbarRoot = createRoot(this.#ensureToolbarHost());
      this.#toolbarRoot.render(
        <ToolbarButton model={this.#model} leaveGuardRef={this.#leaveGuardRef} />,
      );
    } else if (this.#toolbarRoot) {
      this.#toolbarRoot.unmount();
      this.#toolbarRoot = null;
      this.#toolbarHost?.remove();
      this.#toolbarHost = null;
    }
  }

  #applyWand(plan: EntryMountPlan): void {
    if (plan.wand) {
      const host = this.#ensureWandHost();
      if (!host || this.#wandRoot) return;
      this.#wandRoot = createRoot(host);
      this.#wandRoot.render(<WandEntry model={this.#model} leaveGuardRef={this.#leaveGuardRef} />);
    } else if (this.#wandRoot) {
      this.#wandRoot.unmount();
      this.#wandRoot = null;
      this.#wandHost?.remove();
      this.#wandHost = null;
    }
  }

  #ensureToolbarHost(): HTMLDivElement {
    if (this.#toolbarHost) return this.#toolbarHost;
    const host = document.createElement("div");
    host.className = "stm-toolbar";
    (document.getElementById("top-settings-holder") ?? document.body).appendChild(host);
    this.#toolbarHost = host;
    return host;
  }

  /** 魔法棒项宿主：挂在 #extensionsMenu 下（与内置工具行同级；可见项会点亮魔法棒按钮） */
  #ensureWandHost(): HTMLDivElement | null {
    const menu = findWandMenu();
    if (!menu) return null;
    if (!this.#wandHost || this.#wandHost.parentElement !== menu) {
      const host = document.createElement("div");
      host.className = "stm-wand-entry-host";
      menu.appendChild(host);
      this.#wandHost = host;
    }
    return this.#wandHost;
  }

  #startWandWaiting(): void {
    if (this.#wandObserver) return;
    this.#wandObserver = new MutationObserver(() => {
      if (findWandMenu()) this.#onWandReady();
    });
    this.#wandObserver.observe(document.body, { childList: true, subtree: true });
    this.#wandTimer = setTimeout(() => this.#onWandTimeout(), WAND_WAIT_TIMEOUT_MS);
  }

  #stopWandWaiting(): void {
    this.#wandObserver?.disconnect();
    this.#wandObserver = null;
    if (this.#wandTimer !== null) clearTimeout(this.#wandTimer);
    this.#wandTimer = null;
  }

  #onWandReady(): void {
    this.#stopWandWaiting();
    this.#applyPlan(planEntryMount(this.#readPlacement(), true));
  }

  #onWandTimeout(): void {
    this.#stopWandWaiting();
    // 保持当前回退计划（顶部落位）；replan 时若菜单已出现会自然升级
  }
}

function findWandMenu(): HTMLElement | null {
  const menu = document.getElementById(WAND_MENU_ID);
  return menu instanceof HTMLElement ? menu : null;
}