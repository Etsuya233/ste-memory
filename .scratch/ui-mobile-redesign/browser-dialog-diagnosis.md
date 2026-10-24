# Browser Use 原生弹窗控制诊断

日期：2026-10-23。范围：只读插件文档与实现；未操作用户浏览器，未修改插件。

## 结论与置信度

高置信度：重新附加调试器时，焦点模拟初始化发生在关闭原生弹窗命令之前；初始化超时会阻止关闭命令发出。该调用顺序与现场 `Emulation.setFocusEmulationEnabled timeout` 一致。

这解释了为何普通页面操作可用、弹窗可被识别，但关闭失败。未在用户浏览器重现或注入诊断代码，因此不把全部现场原因视为已完全证明。

## 源码证据

插件文件：`C:/Users/Etsuya/.codex/plugins/cache/openai-bundled/browser/26.1013.40934/scripts/browser-service.mjs`。该文件已压缩，以下多个函数处于同一物理行。

- **1322 行，`getJsDialog`**：从 `jsDialogsByTabId` Map 读取弹窗。能读到弹窗不能证明 CDP 连接当前可执行命令。
- **1329 行，`G_` 与 `zO`**：accept/dismiss 调用 `cdp.callTarget(..., "Page.handleJavaScriptDialog", ...)`，并等待 `Page.javascriptDialogClosed`。
- **1322 行，`callTarget`、`executeTargetCdp`**：发送命令前先等待 `ensureAttachedTab`。`throwIfJsDialogBlocksMethod` 已允许 `Page.handleJavaScriptDialog`，问题发生在后续附加流程。
- **1322 行，`ensureAttachedTab`、`attachTab`**：未记录为 attached 时，执行 `api.attach`，然后等待 `enableFocusEmulation`；完成后才 `attachedTabIds.add` 和初始化 Page 等域。
- **1322 行，`enableFocusEmulation`、`Cf`**：发送 `Emulation.setFocusEmulationEnabled`；匹配 deadline/timed out 的错误重新抛出。因此焦点初始化超时会令关闭命令无法发出。
- **1329 行，`FY`**：AX 弹窗按钮和 Escape 最终调用同一个 `G_`，因此换 AX 输入仍可能进入相同故障链。
- **1322 行，`forgetAttachedTab`**：清除连接状态时也删除弹窗 Map，可解释后续偶发弹窗缓存缺失。`No dialog showing` 单独不足以证明原生弹窗已经关闭。
- **1334 行，`tab_get_js_dialog`**：先执行 URL 内容访问权限检查，然后读取缓存。
- **1329 行，`tab_handle_js_dialog`**：保留 URL 操作权限检查，再调用弹窗处理。

## 受支持恢复范围

连接仍有效时，公开 API `tab.getJsDialog()` 后调用该弹窗的 `dismiss()` 或 `accept()` 是正确路径。当前初始化超时后，未找到公开 API 可跳过该初始化；反复绑定、dismiss、AX Escape 均不能保证恢复。

工具目录另提供 `mcp__chrome_devtools__handle_dialog({ pageId, action: "dismiss" })`，但未确认其连接用户当前 Edge 实例，不能据此声称能恢复该标签页，也不能猜测 pageId。

Computer Use 已被 URL 识别安全检查拒绝，该路径保持停止；不使用自造 CDP、HTTP 或系统输入绕过。开发工作可继续通过源码审查和独立预览进行。

相关文档：`browser/26.1013.40934/docs/browser-troubleshooting.md`、`chrome-troubleshooting.md`。文档指出原生宿主和扩展诊断不改变 CDP 行为，不应擅自修复宿主或用脚本替代失效的浏览器控制。

## 未证实部分

首次 `Input.dispatchMouseEvent` 超时是否直接触发扩展端 detach，尚未证明。服务发送命令默认不启用 `preserveDebuggerOnTimeout`，但实际扩展端超时处理未在此次读取范围内。不能把这个因果链当成已确认事实。

未执行现场协议跟踪，所以无法确认当前每一次失败对应的具体连接生命周期与弹窗缓存状态。

## 工具修复建议

维持原有 URL 与权限检查，在附加调试器后优先处理已存在的原生弹窗；把焦点模拟和其他可能阻塞的初始化延后到弹窗关闭之后。补充“原生弹窗已打开时重新附加调试器”的回归测试。此建议仅记录，未修改插件。
