import { createRoot, type Root } from "react-dom/client";
import type { SteMemoryRuntime } from "../runtime.ts";
import { PanelModel } from "./panel-model.ts";
import { PanelShell, ToolbarButton } from "./panel-shell.tsx";

/**
 * 面板挂载（ST 侧薄层；spec 测试决策：ST DOM 不测）：建两个 React 根——
 * 顶部工具栏按钮（#top-settings-holder，找不到兜底 body）与面板
 * （aside#stm-panel，挂 body 末尾）。状态全部在 PanelModel / manager /
 * settings 存储，组件只做投影；非浏览器环境（Node 测试）直接跳过。
 */
export function mountPanel(runtime: SteMemoryRuntime): void {
  if (typeof document === "undefined") return;
  const model = new PanelModel();

  const toolbarHost = document.createElement("div");
  toolbarHost.className = "stm-toolbar";
  (document.getElementById("top-settings-holder") ?? document.body).appendChild(toolbarHost);
  const toolbarRoot: Root = createRoot(toolbarHost);
  toolbarRoot.render(<ToolbarButton model={model} />);

  const panelHost = document.createElement("div");
  panelHost.className = "stm-panel-host";
  document.body.appendChild(panelHost);
  const panelRoot: Root = createRoot(panelHost);
  panelRoot.render(<PanelShell runtime={{ ...runtime, st: runtime.adapter }} model={model} />);
}
