# 前端开发规范

适用于新页面、公共组件、工作区状态、宿主接线、样式和前端验收脚本。本文是当前开发约定；
[ADR 0029](../adr/st/0029-mobile-records-frontend.md) 记录架构决策，
[开发与验收说明](./frontend-preview.md) 提供预览环境和各页面验收命令。
领域术语以根目录 [CONTEXT.md](../../CONTEXT.md) 为准。
ADR 0028 中逐页混合新旧 UI 的迁移策略已由 ADR 0029 替代；阅读历史文档时注意这一边界。

## 开发顺序与交付标准

1. 先确定页面所属作用域：全局设置、当前对话，或对话与记忆空间的组合。列明读取、写入和离开页面时的行为。
2. 找到下表中的现有组件与业务服务，再选择相近页面作为接线参考。复用公共实现，避免复制整个旧页面后修改样式。
3. 先完成窄屏的一条操作流程，再适配桌面窗口。接入统一导航、离开保护、滚动恢复及当前上下文校验。
4. 验证成功、空态、失败、未保存离开与异步切换。涉及写入时，额外检查提交后同步失败和重复操作。
5. 按改动范围执行检查，记录实际结果与未验证的边界；架构、公共行为或隔离规则变化时同步更新本文和相关 ADR。

交付时应能指出：页面入口、使用的公共组件、服务接口、状态归属、已执行的验证。
公共组件变更应验证至少一个现有调用页面；修复宿主样式问题应有能复现原问题的浏览器检查。
文档中的验收记录只代表对应执行时点，不能作为后续修改已经通过检查的依据。

## 架构与代码归属

当前使用 React、TypeScript、Tailwind 4、shadcn Base UI / Luma（zinc、Lucide、Inter）和 esbuild。
精确依赖版本与命令以 [package.json](../../package.json)、锁文件和构建配置为准。
前端采用普通 DOM 与原生 popover；目前没有 Shadow DOM，也没有独立的前端路由、全局状态库或表单配置引擎。

| 位置                                                                                                       | 职责与边界                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [src/frontend/index.ts](../../src/frontend/index.ts)                                                       | 默认入口，调用 bootstrap 并注入前端挂载函数。                                                |
| [src/frontend/host/st-host.tsx](../../src/frontend/host/st-host.tsx)                                       | 挂载 ST 工具栏入口，连接 runtime、当前对话、工作区与服务回调。页面通过注入接口消费这些能力。 |
| [src/frontend/host/](../../src/frontend/host/)                                                             | 宿主相关接线、预设及维护操作协调、窗口定位。ST DOM 与 runtime 适配集中在此层。               |
| [src/frontend/workbench.tsx](../../src/frontend/workbench.tsx)                                             | 五个主页面、工具子页接入、顶层导航和关闭守卫。                                               |
| [src/frontend/pages/](../../src/frontend/pages/)                                                           | 页面组合、表单草稿和展示；页面需要的能力用明确的 Services/Props 接口表达。                   |
| `pages/records-workspace.ts`、`pages/tables/tables-workspace.ts`、`pages/tasks/tasks-workspace.ts`         | 相应流程的快照、请求归属、加载、编辑和保存状态。通过订阅供 React 使用。                      |
| [src/frontend/components/](../../src/frontend/components/)                                                 | 跨页面的布局、表单组合、导航守卫和滚动管理。                                                 |
| [src/ui/primitives/](../../src/ui/primitives/)                                                             | shadcn 组件、主题、Portal 容器和基础工具；保持与插件业务及 ST 解耦。                         |
| [src/features/](../../src/features/) 与 [src/infrastructure/](../../src/infrastructure/)                   | 既有业务规则、任务、数据与 ST 适配能力。前端沿用服务，避免另建一套持久化或任务调度。         |
| [scripts/build-lib.ts](../../scripts/build-lib.ts)、[scripts/luma-styles.ts](../../scripts/luma-styles.ts) | 生产与预览共享的构建及样式编译规则。                                                         |

旧 `src/index.ts`、旧 React 页面、`src/ui/kit` 与旧样式保留源码，默认构建不接入。
新前端可以引用旧目录中已经存在的纯模型，例如 `record-form-model.ts`、`record-sort-model.ts` 和字段草稿转换；
引用前检查其依赖，保持无旧组件、旧样式或隐式宿主副作用。迁移这些模型属于独立重构，勿在页面开发中批量搬运。

工作区负责需要跨视图保留的流程状态，局部 React state 负责局部表单与展示。
不要为每个小表单新建工作区，也不要把同一份领域数据同时存入多套状态容器。
订阅现有工作区时沿用 `useSyncExternalStore`；耗时请求、计时器和事件订阅放在明确的生命周期中，并提供清理。
新增依赖应有现有方案难以满足的实际需求，避免仅为包装已有组件引入第二套 UI、状态或表单系统。

## 公共组件复用

按“基础控件 → 公共组合 → 页面”的顺序查找。抽取已经重复的交互或明确共用的业务表单，
保持 props 能直接表达用途。避免只有一层转发、没有统一行为的包装方法，以及依赖大量配置解释的通用表单。

| 需求                                 | 优先使用                                                                               | 使用约定                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 页面骨架、页头、滚动区、页脚         | [PageHeader / PageContent / PageFooter](../../src/frontend/components/page-layout.tsx) | 沿用关闭、返回和亮暗色控件。公共页头同时提供桌面窗口拖动区域。                         |
| 表单保存栏                           | 同文件的 `SaveActions`                                                                 | 统一保存位置、busy/dirty 状态与取消入口；通过 `formId` 关联表单。                      |
| 设置编辑页                           | [SettingsEditor](../../src/frontend/pages/settings/connection-settings-editor.tsx)     | 已组合布局、离开保护、刷新提示、错误与保存栏；`contentProps` 可接入滚动 ref/onScroll。 |
| 确认操作、未保存离开                 | [ConfirmAction / usePageLeave](../../src/frontend/components/confirmation.tsx)         | 接入顶层 `registerLeaveGuard`，避免另建导航确认状态。                                  |
| 空态、错误、状态提示                 | [PageEmpty / PageError / StatusNotice](../../src/frontend/components/page-state.tsx)   | 显示实际原因和可执行动作，异步失败不能伪装为空列表或保存成功。                         |
| 带说明的开关                         | [SwitchField](../../src/frontend/components/form-fields.tsx)                           | 统一 label 激活、说明、禁用与可访问属性。                                              |
| 记忆字段输入                         | [RecordFieldInput](../../src/frontend/components/record-fields.tsx)                    | 沿用字段值转换、引用选项和错误语义。                                                   |
| 表结构与字段配置                     | [SchemaEditorFields](../../src/frontend/components/schema-editor-fields.tsx)           | 表格和预设共享，差异通过明确 props 表达。                                              |
| 自动填表配置                         | [AutoFillFields](../../src/frontend/components/auto-fill-fields.tsx)                   | 全局配置与对话覆盖共享字段，页面负责继承和保存语义。                                   |
| 密钥显示/隐藏                        | `connection-settings-editor.tsx` 的 `SecretInput`                                      | 显隐状态为局部状态；沿用表单保存流程。                                                 |
| 记录排序                             | [RecordSortMenu](../../src/frontend/components/record-sort-menu.tsx)                   | 复用可排序字段模型，服务对完整匹配集排序后分页。                                       |
| 记录表格展示                         | [RecordsTable](../../src/frontend/components/records-table.tsx)                        | 只读展示当前页字段值，复用字段格式化；点击进入工作区的记录编辑流程。                   |
| 下拉框、按钮、输入、确认框等基础控件 | [primitives](../../src/ui/primitives/) 中已安装的组件                                  | 使用实际 Base UI API，组件 class 合并使用 `cn`。先检查目录，再决定是否添加组件。       |

表单使用 `Field`、`FieldLabel`、`FieldDescription`、`FieldError` 等现有组合，关联控件 ID 与说明。
校验状态同时传递到字段和控件，图标按钮提供明确的 `aria-label`。保留可见键盘焦点；
确认框初始焦点放在保留编辑或取消等安全操作上。菜单和弹窗的键盘交互沿用 Base UI。
字段禁用、隐藏或过期时，数据处理遵守既有业务模型，避免因为界面不显示就丢弃原记录内容。

新增或更新 shadcn 组件时，先确认 Base UI / Luma 与项目别名、前缀，查阅对应组件文档和本地已有实现。
上游代码需要保留本项目的主题、命名空间与 Portal 适配；禁止直接覆盖适配过的文件后仅凭外观验收。
颜色和字号沿用公共主题与组件，使用 `ste:bg-background`、`ste:text-muted-foreground` 等语义 token，
状态优先使用现有 Alert/Badge 变体。布局间距使用 gap 和已有类型尺度，避免在每个页面复制一套颜色、尺寸与圆角。

### 新增设置子页的接线

以 [EmbeddingSettingsPage](../../src/frontend/pages/settings/embedding-settings-page.tsx) 为最小完整参考，
复用 `SettingsSubpageProps` 与 `SettingsEditor`，传入 `controls`、`onBack`、`registerLeaveGuard`、
`dirty`、`busy`、保存和放弃动作。新子页在 [SettingsPage.tsx](../../src/frontend/pages/settings/SettingsPage.tsx)
补齐 `SettingsSection` 类型、分支渲染和 overview 的菜单入口；overview 内部跳转沿用其离开守卫。
只有需要从其他主页面直接打开该子页时，才扩展 `workbench.tsx` 的对应导航回调。
新增服务能力同步补到接口、host 注入和预览 fixture。

`SettingsEditor.scope` 同时作为表单 ID 和离开确认的作用域，保持有效、唯一、随目标身份变化，
不要把草稿正文或随机数放入 scope。`dirty` 控制保存按钮与提交，`navigationDirty` 默认等于 dirty，
控制导航和刷新保护；只有页面存在额外未保存状态时才显式传入，并覆盖所有会随离开丢失的编辑。

## 移动端与桌面交互

所有尺寸共用“列表 → 详情 → 编辑”的页面流程和同一套操作语义。
记录页同时支持只读表格视图，点击单元格、行号或编辑按钮可直接进入同一编辑页。
列表与表格共用搜索、排序和分页；默认列表，视图模式由记录工作区按对话与空间保留。
记录页的横纵滚动及返回焦点按工作区、上下文、视图模式与查询条件缓存；
表头与行号在记录滚动容器内固定，单元格最多显示三行。表格视图不维护编辑草稿。
图标视图切换位于表格选择旁；表格使用圆角滚动容器，右侧固定铅笔编辑列。
单元格按钮高度跟随整行，短文本、行号和编辑列也必须铺满单元格的 hover 与点击区域。
320px 窄屏能完成主要任务，390px 检查常用布局。主要操作可点击，不能依赖 hover、拖拽或仅图标提示。
标签、错误和长内容能够换行；普通页面不产生横向溢出。SQL 结果等二维数据允许在自己的容器内横向滚动。

当前导航在 768px 以下位于底部，桌面位于窗口左侧。左侧按钮保持固定尺寸，从顶部紧凑排列，
剩余空间留在下方。导航与保存栏位于滚动区之外，主体使用 `min-h-0` / `min-w-0` 配合可滚动内容区，
避免整页随内容撑高。布局应同时适应桌面缩小后的实际内容宽度，不能只在全屏桌面下检查。

桌面窗口由 [FrontendPanel](../../src/frontend/host/panel.tsx) 和
[usePanelWindow](../../src/frontend/host/use-panel-window.ts) 管理。页头空白处可拖动，四边与四角可缩放，
按钮和表单操作不触发拖动；窗口受视口边界限制。双击页头还原，聚焦页头后方向键移动、Shift 加方向键缩放、Home 还原。
尺寸与位置在关闭重开后保留，浏览器刷新后重置。拖动通过 CSS 变量更新几何属性，避免让整个页面随 pointermove 重绘。
移动端全屏显示并隐藏缩放手柄；页面不得再实现自己的窗口拖动或缩放系统。

内容区保留安全区间距，动效遵守 `prefers-reduced-motion`。页面内的弹窗与导航不能遮挡必要的取消或保存入口。

### 滚动、返回与焦点

沿用 [usePageScroll](../../src/frontend/components/use-page-scroll.ts) 管理位置，避免为了恢复滚动而默认整页保活。
`owner` 使用生命周期稳定的工作区对象；`viewKey` 区分对话、空间、列表、详情与编辑，
需要时加入表格、搜索、分页、排序和记录标识。用于不同视图的滚动 DOM 应通过 React `key` 区分。

把返回的 `ref`、`onScroll` 传给真正的 `PageContent`。`ready` 在数据与容器可用后才为真，
隐藏或未就绪的视图不能把临时的零位置写进缓存。新进入详情或编辑从顶部开始，返回恢复来源视图的位置；
更换排序等导致列表含义改变的动作回到顶部。对话之间的位置独立，恢复列表时同时保持合理的焦点位置。

“重新进入”与“返回”使用不同的缓存处理：列表重新打开详情前调用 `forget(targetViewKey)` 清除目标旧位置，
返回列表或详情时保留来源缓存；始终置顶且无需恢复的编辑器可传 `remember=false`。
仅改变 React `key` 不会清理 hook 的位置缓存。具体接线见
[TablesPage](../../src/frontend/pages/tables/tables-page.tsx) 中打开表格与开始向量编辑的 `scroll.forget` 调用。

## 对话作用域与异步提交

当前上下文使用真实的 `chatKey` 与 `spaceId`，不能用标题识别对话。
工作区按所属上下文保留草稿；请求开始时捕获目标，提交前通过注入的 `assertContext` 检查实时宿主状态。
同空间不同对话也需要隔离。A → B → A 会使简单的 ID 对比失效，因此请求完成前还应校验请求代次或会话身份。

异步读取的成功、失败和 finally 状态更新都要校验归属。避免旧请求覆盖新对话的数据、错误或 loading。
已开始的写入可能在外部切换对话后完成，结果仍归属原目标，不能把旧详情或确认框自动打开到新对话。
切换时保留可恢复的草稿，不把“切回原对话”视为旧请求重新有效。

`busy` 防止重复提交并阻止主动离开；`dirty` 表示真实的未保存修改。返回、主导航与关闭共用离开守卫，
页面内的直接退出也经过 `requestLeave`。外部 ST 切对话无法靠导航守卫阻止，需要由上下文与请求归属规则处理。
刷新保护沿用工作台及 `SettingsEditor` 的 `beforeunload` 接线；新增未覆盖的草稿流程要补齐保护。

### 已提交与未提交的失败

保存沿用既有修订冲突校验。未提交失败保留草稿和错误；业务已提交、文件或缓存同步失败时，
界面必须明确已提交的结果，并提供快照保存重试。记录流程沿用 `MemoryRecordSaveError`，
预设与维护沿用各自服务的提交结果和同步警告；先阅读相应 host 服务，再接入页面。
禁止把所有异常都转成可重按的业务提交，以免重复创建记录、应用预设或恢复备份。

设置保存应基于最新设置只更新目标字段，保留其他页面刚保存的值。
预设比较、向量预览与连接测试应明确使用的配置快照；来源变化后失效或重算。
草稿预览保持只读，不能隐式保存配置、提交索引任务或请求模型。

任务轮询在页面离开、面板关闭和浏览器隐藏后停止，后台任务按现有任务服务继续。
手动检索离开后取消；问答历史与后台运行使用现有 `QueryChatStore`，遵守其空间和模式隔离。
新异步功能先明确生命周期，再复用相近服务的实现，避免让页面可见性决定已经提交的业务是否存在。

## ST 样式隔离

ST 与插件共处一个文档。Tailwind 类名前缀仅隔离类名，无法屏蔽 ST 对元素、通配符或继承属性的规则。
每次排查应同时检查匹配的选择器、层叠层、important、属性是否直接作用于控件，以及最终 computed style。
同为 important 的声明还受层叠层顺序影响，不能仅凭选择器更长或加载更晚判断胜负。
窗口坐标等动态值沿用 CSS 变量与现有工具类接线，避免被基础 `ste:inset-0` 等 important 工具类覆盖。

| 隔离措施                          | 作用与代码位置                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ste:` 前缀与 important utilities | 降低类名冲突并应对 ST 未分层的样式；见 [primitives/theme.css](../../src/ui/primitives/theme.css)。页面新增工具类也使用此前缀。                                                |
| `.stm-luma` 与 `data-tone`        | 主题变量和局部基础规则限定在插件子树；亮暗色从面板传入。不要修改宿主 `html` / `body`。                                                                                        |
| 局部样式入口，无全局 Preflight    | [frontend/theme.css](../../src/frontend/theme.css) 引入 primitives theme；仅扫描显式源码。旧 kit 和旧页面 CSS 不合并。                                                        |
| 变量、动画和初始化器命名空间      | [isolateLumaStyles](../../scripts/luma-styles.ts) 处理生成的 Tailwind 内部变量、keyframes 与 fallback 初始化器，避免向宿主或其他插件泄漏。                                    |
| 原生 top-layer popover            | 面板不受 ST 祖先 transform 改变 fixed 定位参照的影响；继续沿用 `FrontendPanel`，无需靠扩大 z-index 穿透宿主。                                                                 |
| 同一 Portal 容器                  | [PrimitivesProvider](../../src/ui/primitives/provider.tsx) 注入面板容器；菜单、Tooltip、AlertDialog 保持在主题与 top-layer 子树。面板隐藏时关闭浮层，避免恢复焦点到隐藏元素。 |
| 构建嵌入字体                      | `compileLumaStyles` 将 Inter 嵌入产物；运行时不额外请求字体 CDN。                                                                                                             |

通用组件不直接读取 ST 设置或查找 ST DOM。新增浮层复用 provider 的容器与 active 状态，
保持 Base UI 的焦点和关闭流程；禁止默认 Portal 到 `document.body` 或叠加第二套焦点陷阱。
新增 CSS 放到对应公共主题或前端样式入口，选择器限定作用域；不要通过修改宿主全局选择器解决插件问题。

新增浮层以 [alert-dialog.tsx](../../src/ui/primitives/alert-dialog.tsx) 为接线范例：
`usePrimitivesContainer` 提供 Portal 目标，`usePrimitivesActive` 控制可见生命周期，
`useDismissWithSurface` 通过 Base UI actions 正式关闭，`canRestoreSurfaceFocus` 校验最终焦点目标是否可见。
仅隐藏 Portal 会遗漏受控 open 状态和焦点清理，不能替代上述关闭过程。

### 字号排查

`font-size` 可以继承；控件自己匹配到的声明会参与它自身的层叠。
外层字号只有在控件未确定自身字号时才通过继承生效。`ste:text-sm` 能设置控件字号，
但不能清除宿主给控件直接设置的其他属性，也不意味着整个 Tailwind 组件天然具有最高优先级。
遇到 `max(16px, var(...))` 等声明，先在浏览器确定它来自哪个样式文件、匹配哪个元素，再调整对应规则。
控件字号使用公共组件的类型尺度；避免在页面内复制字号覆盖或用全局根字号补偿局部冲突。

### 已修复：全局文字阴影

ST 的全局 `text-shadow` 既可能被继承，也可能直接匹配输入框等元素。旧 `.ui-theme` 曾清除阴影，
新入口未引入旧 kit 时需要自己保留该隔离。当前规则位于 `frontend/theme.css`：

```css
.stm-luma,
.stm-luma::before,
.stm-luma::after,
.stm-luma *,
.stm-luma *::before,
.stm-luma *::after {
  text-shadow: none !important;
}
```

此规则覆盖表单、浮层及伪元素。后续主题修改保持该边界，不能只给文字容器清阴影。
回归时在插件样式之后注入宿主全局阴影，检查插件内部为 `none`，并确认外部宿主元素仍有原阴影。

### 已修复：原生下拉框双重箭头

ST 给原生 `select` 设置 `background-image: url('/img/down-arrow.svg')`，
[NativeSelect](../../src/ui/primitives/native-select.tsx) 同时绘制自己的 Lucide SVG 箭头。
`appearance: none` 仅关闭浏览器原生外观，宿主背景图仍会显示，所以会出现两个箭头。
公共组件现有的 `ste:appearance-none ste:bg-none` 分别处理这两层，保留组件自己的图标。

后续使用公共 `NativeSelect`，保持背景图清除规则；不要在每个页面隐藏图标来补偿 ST 样式。
宿主背景色与背景图是不同属性，`ste:bg-input/50` 不能代替 `ste:bg-none`。
单选回归要同时检查 `appearance === 'none'`、`backgroundImage === 'none'` 与一个组件箭头，
并确认选项切换仍有效。多选沿用组件的无箭头逻辑。

## 验证与协作

运行命令与页面脚本索引见 [开发与验收说明](./frontend-preview.md)，基础命令见 README。
先运行改动覆盖到的模型/工作区测试与浏览器流程，再按变更范围执行类型、Lint、格式和生产构建检查。
业务提交、共享异步状态或公共组件影响广泛时扩大回归；文档修改验证路径、示例与规则一致性，无需为文档运行全仓业务测试。
避免添加只镜像实现的测试，优先锁定用户可见的错误和真实边界。
批量检查控件样式时，先断言确实匹配到目标控件，再逐项检查，避免空集合的 `every` 使回归误通过。

| 改动范围           | 必须关注的回归                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| 公共样式或基础控件 | `verify-frontend.mjs` 的宿主样式注入、表单、Tooltip、确认框、窄屏与桌面检查；验证受影响的其他调用页面。       |
| 窗口或主导航       | `verify-desktop-window.mjs` 的拖动、边界、缩放、紧凑侧栏、关闭重开与移动切换，以及主流程离开保护。            |
| 工作区或提交       | 对应单元测试和页面脚本，覆盖过期响应、A → B → A、保存中切换、冲突及提交后同步失败。                           |
| 滚动与返回         | `verify-tables.mjs` 等对应流程，覆盖加载后恢复、进入子页置顶、导航切回和对话隔离。                            |
| 预设、预览或排序   | 对应 `verify-preset-update.mjs`、`verify-vector-preview.mjs`、`verify-record-sorting.mjs`，沿用真实服务语义。 |
| 记录表格展示       | `verify-record-table.mjs` 覆盖字段值、三行预览、固定表头与行号、横纵滚动恢复、直达编辑和窄屏操作。            |

独立预览使用 [docs/ui/frontend-preview.tsx](./frontend-preview.tsx) 的内存数据，服务接口与生产共用。
新增能力同时补齐 host 接线和必要的预览实现，不能把假数据或调试入口接入生产。
独立预览通过不代表真实 ST 文件写回已验证；执行真实写入验收时使用专门测试对话，报告清楚数据环境。
截图、日志和报告应脱敏，临时产物放入忽略目录，已跟踪源码不引用 `tmp` 中的资源。

文档格式检查需注意 `docs/` 被 `.prettierignore` 排除，可显式运行：

```sh
pnpm exec prettier --check --ignore-path .gitignore docs/ui/frontend-development.md
```

给子代理分配任务时，明确文件或模块所有权、需要共用的组件与服务、状态作用域和验收流程，
告知其他代理可能同时修改代码，要求保留并适配他人的修改。共享组件应由一个负责人统一修改，
页面负责人按稳定接口接入；完成后由协调者检查导航、服务注入、预览与构建入口是否连通。
开始前核对当前分支和工作目录；构建与 Junction 使用的 `dist` 应属于正在开发的目录，避免修改一处、浏览另一处。
