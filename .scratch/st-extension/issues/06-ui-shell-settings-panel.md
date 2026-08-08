# 06 — 基础 UI 壳与设置面板

**What to build:** 顶部工具栏按钮 + 面板骨架（手机全屏底部抽屉、桌面浮动面板，底部 Tab：表格/记录/任务/设置），落实 UI 风格契约：`--stm-*` 设计令牌（色板集中一处）、`stm-` 类名前缀隔离、深色基调、移动端优先、动效克制；设置面板（插件开关、版本与运行状态、R2 配置占位、记忆宏名配置占位）；表格列表视图（系统表/字段启停生效）；面板显示当前记忆空间信息（名称 + 同步状态占位）。

**Blocked by:** 03 — Dexie 持久层（一）；05 — 空间绑定与消息同步

**Status:** resolved

## Answer

`apps/st-extension/src/` 新增三层（设置纯模型 + 面板纯逻辑 + ST DOM 宿主），全部验收项闭环：

- **设置模型（`settings/plugin-settings.ts`，纯逻辑 seam）**：`PluginSettings { enabled, r2, macroName }` + `mergeSettings`（缺失键补默认、类型不符回退、未知键丢弃——旧数据/损坏数据向前兼容）+ `SettingsStore` 端口（read 每次重取 / write 持久化）。`isR2Configured` 供同步状态占位判定。宿主 = `StSettingsStore`（`st/st-settings-store.ts`，与 StChatAdapter 同法持 getContext 工厂；extensionSettings 缺失时读默认值、写静默跳过；写入触发 `saveSettingsDebounced`）。`StContext` 接口补 `extensionSettings` / `saveSettingsDebounced` 字段。
- **面板纯逻辑（`ui/panel-model.ts` / `ui/table-list-model.ts` / `ui/space-info.ts`，全部可测）**：`PanelModel` 开关与 Tab 状态机（表格/记录/任务/设置）；`buildTableListViewModel` 表 + 按表分组字段 → 展示形状（含 12 种字段类型显示名、N/M 字段启用统计）；`buildSpaceInfo` 头部空间信息（名称 + 同步状态占位：未配置 R2 →「云同步未配置」，四项齐 →「已配置（推送待开放）」，ticket 08 替换真实状态；插件停用 →「插件已停用」优先于空间状态）+ `runtimeStatusLabel`（设置面板运行状态行）。
- **DOM 宿主（`ui/st-panel-host.ts`，ST 侧薄层，spec 测试决策不测）**：顶部按钮插入 `#top-settings-holder`（找不到兜底 body，aria-pressed 同步）；自绘 `aside#stm-panel`（纯 CSS 媒体查询：移动端全屏底部抽屉 / 桌面 ≥1001px 浮动面板，不依赖 ST 主题变量）；底部 Tab + 表格列表（表格/字段启停开关 → core 服务 update 落库，显示策略依赖字段的保护规则报错经 toastr 呈现、不落库；首个表格默认展开字段，展开状态重渲染保持）；设置 Tab（插件总开关经 extensionSettings 持久化 + 重新启用立即恢复同步、版本与运行状态、R2 四项占位输入禁用、记忆宏占位禁用）；头部随 manager 状态变化重渲染（渲染序号丢弃过期异步渲染）；空状态文案「记录视图即将开放 / 任务状态即将开放 / 插件已停用」。
- **运行时接线（`runtime.ts` / `bootstrap.ts`）**：`SteMemoryRuntime` 补 `spaces/tables/fields` 服务、`settings` 存储、`version`；**插件总开关门控**——`settings.read().enabled` 为 false 时启动不同步、CHAT_CHANGED 事件桥跳过（设置面板重新启用时宿主触发 `syncToCurrentChat` 恢复）；bootstrap 默认 start 链式 `startSteMemory → mountPanel`（非浏览器环境内部自守卫）。
- **样式（`style.css`）**：令牌区块新增 `--stm-border`；面板/按钮/Tab/表格行/字段行/自绘开关/设置行/空状态全部只走令牌（全文件 hex 仅存在于 :root 令牌区块）；触控目标 ≥44px（Tab 44px、开关 label 52×44、展开按钮 44×44、关闭按钮 44×44）；动效只留抽屉开合与开关状态反馈，`prefers-reduced-motion` 全禁用；iOS 安全区 `env(safe-area-inset-bottom)`。
- **测试（包内 122/122 绿，全仓 389/389 绿，typecheck/lint/build 全绿）**：settings 合并/损坏数据/R2 判定（7 例）；settings store 宿主（默认值、写后读回、防抖触发、损坏值、缺失 extensionSettings、每次重取语义）；PanelModel 状态机（开关/Tab/订阅）；表格列表视图模型（分组/统计/类型标签契约——12 种类型全覆盖断言）；空间信息（各状态文案/插件停用优先/同步占位）；runtime 新面（服务与版本暴露、**停用门控全路径**：启动不同步、事件桥跳过、重新启用恢复、启用后事件恢复）。
- **手动验收（2026-08-08 真机，`docs/playwright-st-extension/verify-ui-shell.mjs` 23 项全过）**：真实 ST 1.18 中——移动端（390px）顶部按钮呼出全屏底部抽屉（computed style 断言）→ 空间名 + 四 Tab + 8 张系统表 + 首个表格展开 7 字段 → 表格停用落 Dexie + UI 反映 → 停用显示策略字段 toastr 报错不落库、停用普通字段落库 → 记录占位 → 设置 Tab（开关/版本 v0.1.0/运行状态/R2 4 个禁用输入/宏占位禁用 + 默认名）→ 插件开关关闭持久化到 extensionSettings + 头部「插件已停用」、重开恢复 → 收起面板 + aria-pressed 同步 → 桌面（1280px）浮动面板（top 56 / right 16 / width 400）→ 全流程无插件相关页面错误。

## Checklist

- [x] 顶部按钮呼出/收起面板；桌面浮动与手机全屏抽屉布局均可用（真机 23 项验收含双布局 computed style 断言）
- [x] 系统表/字段启停落库并在表格列表反映（Dexie 断言 + UI 开关同步；显示策略保护规则 toastr 呈现）
- [x] 设置项经 extensionSettings 持久化；插件开关生效（关闭门控同步与事件桥，重启恢复；runtime 测试全路径）
- [x] 令牌集中定义，改色只动令牌区块（全文件 hex 仅存在于 :root）；类名前缀不污染 ST 样式（stm- 前缀 + 自包含视觉）

## Comments

- 2026-08-08 code-review（双轴并行）结论：Standards 无硬违规（仅判断级：space-info 两个函数对 SpaceContextStatus 重复 switch——与 manager 自身模式同构、状态机固有；`activeStatus`/`isActiveStatus` 双 helper 已合并为单函数）。Spec 无 blocker；采纳四条修复：①触控目标补齐 ≥44px（开关 label 52×44 轨道居中、展开按钮 44×44）；②移动端抽屉改全屏 100dvh（原 92vh 未达「全屏底部抽屉」字面）；③去掉工具栏按钮装饰性 opacity 过渡（动效契约只留抽屉开合与状态反馈）；④验收脚本「记忆宏占位」断言原先误查插件开关——宿主补 `data-stm-field` 属性，断言改为精确检查宏输入禁用 + 默认名 `{{memoryContext}}`。
- 未采纳（判断级）：`--stm-success/--stm-danger` 令牌暂未使用（既有令牌，留待状态色场景）。
- 真机验收踩坑（已入 playwright 文档）：①UI 首屏依赖对话绑定——验收前必须清测试角色对话文件残留（否则 space-missing 分支不建空间）；②indexedDB getAll() 按主键 UUID 排序非 createdAt，「停用第一个表格」的 id 要从被点击 DOM 元素 dataset 取，不能从 getAll() 对照；③系统表显示策略引用 fields[0]，停用第一字段必然触发 core 保护规则——脚本特意断言该报错路径再验证普通字段；④page.evaluate 谓词无法引用 Node 侧函数，Dexie 断言用 Node 侧轮询（waitForDbState）。
- 遗留记录：①工具栏按钮触控高度受 ST 顶栏本身高度约束（~35px，ST 自带 drawer-icon 同规格），属宿主容器限制，未强行放大；②`bootstrap` 注入 fake start 的测试路径不挂面板（生产默认路径挂载，真机验收覆盖）；③「同步状态」在 ticket 06 为占位文案（未配置/已配置），ticket 08 接入真实最近同步时间/失败提示；④R2 与宏配置控件禁用，字段已入设置模型并随 extensionSettings 持久化，ticket 08/15 只接控件与行为。
- 2026-08-08 后续决策（用户拍板）：**UI 渲染层改用 React 19**——本票的原生 DOM 宿主已整体迁移为 React 组件层（`ui/panel-shell.tsx`，ADR 0005 修订 ADR 0001 的「不引入框架」表述）。迁移要点：纯逻辑 seam（panel-model / table-list-model / space-info）与全部测试原样保留；组件依赖 `PanelRuntime` 端口；`useEffect` + cancelled 标志替代渲染序号；`useSyncExternalStore` 订阅模型与 manager 状态；esbuild 加 `jsx: automatic` + NODE_ENV define；新增 8 个 renderToString 冒烟测试（无 jsdom，沿用「无组件测试基建」决策）；验收脚本 23 项在 React 实现上重跑全过（仅「默认激活表格 Tab」断言从查 `--active` 类改为查区块存在——条件渲染后 DOM 只含激活区块）；bundle 155KB → 352KB（minified）。
