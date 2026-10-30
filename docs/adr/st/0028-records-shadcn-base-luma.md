# 记录页采用 shadcn Base UI / Luma，保留可迁移组件边界

记录页使用官方 shadcn **Base UI**（不是 Radix）Luma 组件，精确 preset
`beEgoEQi`：zinc base/theme/chart、Lucide、Inter、默认圆角、subtle menu accent。
来源为 `https://ui.shadcn.com/r/styles/base-luma/`，preset 以官方 CLI
`shadcn preset decode beEgoEQi --json` 校验。

## 边界

- `src/frontend/primitives/`：通用组件、主题、portal 容器上下文；禁止导入插件业务与
  SillyTavern，允许单独复制或未来抽为依赖。
- `src/ui/memory/record-*`：记录领域文案、查询与编辑接线、工具栏和列表组合。
  数据服务、字段校验、记录身份、备份和持久化契约不变。
- 旧 `src/ui/kit/` 继续服务其他页面，避免一次性迁移牵连既有页面。

## 宿主隔离

Tailwind 只编译 theme/utilities，不导入全局 Preflight；工具类使用 `ste:` 前缀。
局部 baseline 和 zinc tokens 限于 `.stm-luma`，亮暗色来自宿主适配器的 `data-tone`，
不让通用组件读取插件设置。组件工具类使用 important 应对酒馆未分层样式。
Inter 字体随产物嵌入，不发起运行时第三方请求。

插件面板是原生 `popover` top layer，Base UI 浮层不能默认 portal 到 `body`：
由宿主注入 `PrimitivesProvider.container`，菜单保留在面板及主题子树内。
PageChrome 的栏位 portal 也留在同一主题祖先下。焦点、菜单键盘导航由 Base UI
负责，不复制手写 roving tabindex，不叠加另一套 modal 焦点陷阱。

## 构建与验证

构建、watch、sync 共享 Tailwind 编译入口，产物仍由现有 manifest 引用 `style.css`。
同步的未保存修改守卫仍保留原生确认（调用方要求立即返回 boolean），不为换组件改动其提交/取消契约。

不添加运行时依赖 CDN、不部署或发布。真实浏览器验收使用无酒馆依赖的内存
fixture，不接触用户聊天与记忆；其覆盖范围与结果见记录页验收文档。
