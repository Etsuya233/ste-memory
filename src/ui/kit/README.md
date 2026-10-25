# 公共 UI 组件

本目录是可以单独迁移的 React UI 源码。生产代码只依赖 React，CSS 无需 Tailwind、字体图标库或构建插件。要求 React 19，以及支持原生 dialog、popover、CSS color-mix 和 :has()的现代浏览器。STE Memory 的业务数据、SillyTavern 接口、外观存储与图标适配均留在目录外。

## 迁移到其他插件

复制本目录的生产源码与两个 CSS 文件，安装 React / React DOM，在应用入口加载 `theme.css` 和 `components.css`。将组件放在一个 `Theme` 内；已有根元素时，给根元素加上 `ui-theme`，再展开 `themeAttributes(theme)`。主题只在根部设置一次，子组件通过 CSS 继承，不需要逐个传参，也不需要 Context。

```tsx
import { Theme } from "./kit/theme.tsx";
import { ListGroup, ListRow, NavigationRow } from "./kit/list.tsx";
import { Switch } from "./kit/controls.tsx";
import "./kit/theme.css";
import "./kit/components.css";

<Theme
  theme={{
    appearance: "glass", // glass | classic | material
    tone: "light", // light | dark，由宿主根据底色决定
    background: "#f2f2f7",
    accent: "#2563eb",
    accentForeground: "#fff",
  }}
>
  <ListGroup>
    <NavigationRow title="连接" description="管理服务连接" onClick={openConnection} />
    <ListRow
      title="自动更新"
      trailing={<Switch label="自动更新" checked={enabled} onChange={changeEnabled} />}
    />
  </ListGroup>
</Theme>;
```

外观存储与颜色亮度计算属于宿主职责。主题本身不保存设置、不访问网络。根部支持 `data-font="serif"` 和 `data-size="compact|normal|large"`；默认使用系统字体和标准字号。

## 组件职责

| 文件              | 用途                                                     |
| ----------------- | -------------------------------------------------------- |
| `theme.tsx`       | Theme 包装与可展开到现有根元素上的主题属性               |
| `list.tsx`        | 列表组、分组标题、导航行、操作行、静态信息行             |
| `controls.tsx`    | 按钮、输入、多行输入、原生选择、开关、表单分组与字段关联 |
| `actions.tsx`     | 图标按钮、操作胶囊；图标使用 children 注入               |
| `tabs.tsx`        | 页面 Tab，统一方向键、Home/End、选中项焦点               |
| `segmented.tsx`   | 表单内互斥选项，使用按钮组语义                           |
| `disclosure.tsx`  | 原生 details 展开区，可选 leading 图标槽                 |
| `action-menu.tsx` | 原生 popover 操作菜单，焦点、键盘导航及自定义触发器      |
| `dialog.tsx`      | 原生模态层、Escape、焦点恢复、外部点击关闭               |

原生控件属性、事件、表单关联、data 属性与 ref 继续可用；Dialog 自行管理原生节点生命周期。`FormField` 使用 render function 将 `id`、`aria-describedby`、`aria-invalid` 传给实际控件。

`NavigationRow` 的整行是一个按钮。行中需要独立开关时使用 `ListRow`，或将导航按钮与开关并列放在列表项中，避免嵌套交互元素。`ListGroup` 用 `as="ul|ol"` 时，子项需使用 `li`；普通分组可直接放多行。

菜单触发器通过 `renderTrigger` 注入，必须把提供的原生按钮属性和 ref 传给实际按钮。菜单和弹窗保留在主题根的 DOM 子树中，原生 top layer 负责显示层级，主题继承得以保留。不要把它们 portal 到主题根以外。

## 外观的修改位置

`theme.css` 定义颜色、尺寸、材质等语义令牌；`components.css` 定义公共结构与必要的控件形态。Glass 的内容组使用干净实色表面，操作胶囊和浮层使用磨砂；Classic 使用实色和清晰边界；Material 使用带强调色的表面与填充状态。模糊仅用于操作层与浮层，长列表不逐行模糊。

新增页面只控制页面布局与专用内容，公共控件的圆角、背景、焦点和按压规则放回组件目录统一维护。当前宿主通过 `src/ui/styles/tokens.css` 将 `--stm-*` 映射到 `--ui-*`，该文件不需要复制到其他插件。

## 验证与独立预览

在本仓库执行 `pnpm preview:ui`，打开 http://127.0.0.1:8801/ 。该预览只加载本目录的组件和 CSS，可对照三种样式、切换深浅与强调色、操作菜单及弹窗；页面数据仅存在 React 状态中。示例入口在 `docs/ui/kit-preview.tsx`，生产构建不包含预览。

`kit.test.tsx` 检查依赖隔离、主题入口和原生交互语义，以及表单字段关联。真实浏览器验收还需覆盖手机与桌面尺寸、菜单方向键、禁用态、弹窗焦点与原有业务流程。
