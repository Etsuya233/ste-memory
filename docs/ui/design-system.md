# UI 设计系统（墨灰）

状态：**已实现于分支 `feat/redesign`（提交 5595229）**，尚未合并进主线。改面板 UI 前先读本文件，并参考视觉规格原型 `.scratch/ui-redesign/prototype.html`。

## 一句话

单一视觉语言：zinc 中性阶 + 语义令牌 + 四个外观旋钮（主题 / 强调色 / 字体 / 字号）；面板骨架 = 顶栏 + 侧边抽屉 + 内容区。

## 文件地图

| 文件 | 职责 |
|---|---|
| `src/ui/styles/tokens.css` | 唯一的色值/字体/尺寸定义处；三层结构（色阶 → 语义 → 旋钮）+ 旧令牌兼容别名 |
| `src/ui/styles/panel-shell.css` | 面板骨架、抽屉、共享控件（`.stm-button` / `.stm-input` / `.stm-switch` / `.stm-segmented` / `.stm-empty` 等） |
| `src/ui/styles/memory-tables.css` | 共享表单控件（`.stm-select` / `.stm-textarea`）与表格模块样式 |
| `src/ui/shell/panel-shell.tsx` | 顶栏、抽屉渲染、外观 `data-*` 写入 |
| `src/ui/shell/panel-model.ts` | 面板状态：`open` / `tab` / `navOpen` |
| `src/ui/shell/appearance-model.ts` | 外观选项、中文标签、折叠摘要 |
| `src/ui/settings/settings-tab.tsx` | 「外观」设置分组 |
| `.scratch/ui-redesign/prototype.html` | 视觉规格原型（记录 / 任务 / 设置三页可交互；表格页只是薄壳） |
| `docs/playwright-st-extension/verify-*.mjs` | 真实 ST 验收脚本；DOM/类名改动必须同步 |

## 硬规则

1. 组件样式只引用语义令牌（`--stm-bg` / `--stm-surface` / `--stm-border` / `--stm-fg` / `--stm-fg-2` / `--stm-accent` …），类里不出现十六进制字面量；
2. 按钮只有五种变体（primary / secondary / outline / ghost / danger），尺寸复用 `btn-sm` / `btn-xs`；
3. 圆角两档：`--stm-radius`（10）用于控件、`--stm-radius-card`（14）用于卡片；控件高度 `--stm-control-h`（44）；
4. 字号四档 `--stm-fs-xs/sm/md/lg`（跟随 `--stm-font-scale` 缩放），不要新增 px 字号；
5. 分组 = 分组标签 + 卡片 + 细线分隔（`--stm-border`），不用虚线、不给每行描边；
6. 不新增依赖、不新增 CSS 文件；局部类统一 `.stm-` 前缀，放进对应模块的现有 CSS 文件。

## 四旋钮

- 属性挂在 `#stm-panel`：`data-theme="dark|light"`、`data-accent="teal|blue|indigo|neutral"`、`data-font="system|serif"`、`data-size="compact|normal|large"`；默认 `dark + teal + system + normal`。
- 设置模型：`PluginSettings.appearance`（`src/features/settings/plugin-settings.ts`，`mergeSettings` 逐字段回退）；面板挂载与设置变化时由 `PanelShell` 写入属性。
- 新增主题/颜色/字体/字号档：先加令牌与预置，再改 `appearance-model.ts` 的选项表，最后补设置组 UI。

## 布局原语（尚未实现，模块迁移前先补）

原型里的页面拼装件还没有公共类。第一轮模块迁移前先把它们提炼进 `panel-shell.css`：
`.stm-card`、`.stm-section-label`、`.stm-row`、`.stm-list-row`、`.stm-field`、`.stm-divider`。
在此之前，禁止各模块各造一套卡片/行样式。

## 模块 UI 迁移流程

1. 读本文件 + 原型 + 模块源码/样式/测试 + 相关验收脚本；
2. **先交元素映射表**（现元素 → 目标组件/令牌/新增局部类），确认后再改代码；
3. 只改该模块；数据结构、领域规则、备份格式、ADR 结论不动；
4. 契约：`data-action`、类名、`data-stm-section`、验收脚本断言；改动必须同步脚本，不许删断言；
5. 验证：`mise exec -- pnpm typecheck && pnpm lint && pnpm test && pnpm build`；在真实 ST 刷新核对；
6. 回报：映射表、改动文件、验证结果、自行决策点、未做事项。

## 当前边界（2026-10-19）

- 各 Tab 内部布局与组件尚未迁移，仍使用旧令牌别名（颜色已跟随新令牌，形状/密度未变）；
- 字号旋钮目前只影响骨架与共享控件（模块内仍是 px 字面量）；
- 桌面端抽屉与移动端同为覆盖式，桌面停靠侧栏未做。

## 新会话启动提示词（复制即用）

> 我在继续 ste-memory 的 UI 重构。先读 `docs/ui/design-system.md` 与 `.scratch/ui-redesign/prototype.html`，并确认当前分支（框架在 `feat/redesign`，提交 5595229；不在该分支就先说明）。本任务：<模块> UI 迁移。遵守设计系统的硬规则；先产出元素映射表给我确认，再改代码；不要改其它模块、数据结构与验收断言。
