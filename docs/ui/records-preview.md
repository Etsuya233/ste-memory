# 记录页独立验收

此为旧前端的历史验收记录。默认构建已切换新入口，当前开发请使用
[`pnpm preview:frontend`](./frontend-preview.md)，旧页面与预览源码继续保留。

本地 fixture 渲染真实 `RecordsTab`、`PageLayout` 和通用组件，并以与生产相同的原生 `popover="manual"` 面板包裹。`PrimitivesProvider` 将 Base UI 浮层留在该 top-layer 与主题内。数据是 23 条内存记录、三个表格、六种字段场景（含停用字段）、字段证据及编辑生成的修订历史；刷新即可重置。不会访问 SillyTavern、IndexedDB、用户聊天、模型或任何远端业务接口。

```sh
pnpm install --frozen-lockfile
pnpm build
node --experimental-strip-types scripts/preview-records.ts
# http://127.0.0.1:8802/，?dark 切换暗色
```

另一个终端：

```sh
cd docs/playwright-st-extension
pnpm install --frozen-lockfile --ignore-workspace
CHROME=/usr/bin/chromium node verify-records-preview.mjs
```

可覆盖 `PORT`（预览服务）、`RECORDS_URL`（验收地址）、`CHROME`（浏览器路径）、`RECORDS_SCREENSHOTS`（截图目录）。默认截图保存在仓库 `node_modules/.cache/records-preview/screenshots`，不进入 Git。服务使用构建后的 `dist/style.css`，改样式后须重新构建；改组件后须重启服务。

验收覆盖加载列表、分页、搜索、键盘操作排序菜单及焦点恢复、证据摘录与楼层适配器、编辑与取消保留草稿、保存后停用字段保留、修订历史、删除取消、新建、批量编辑（布尔与多选）与脏数据切表守卫、空表、390px 暗色及浮层位置；捕获浏览器未处理异常。页面故意注入宿主风格的全局控件 CSS，并验证外部 Host 按钮没有被组件样式重置。

该 fixture 验证 UI 接线与交互，不替代真实 SillyTavern 联调、持久化/并发事务测试或数据库领域单测。旧的 `verify-record-crud.mjs` 仍用于完整宿主验收，依赖开发者自行准备的 ST 实例；不要将它对准用户数据环境。

## 当前环境验收限制（2026-10-27）

在助手云端环境中，fixture 已成功通过 esbuild 打包并启动 HTTP 服务；浏览器阶段尚未执行通过。系统 Chromium 启动时因沙箱禁止 Unix socket（`socket() failed: Operation not permitted`）退出；随后通过正式 `require_escalated` 启动也在执行环境初始化阶段失败（`bwrap: Can't create file at /home/agent/.codex/sessions: Read-only file system`）。未尝试更改受限路径。因而不能把上方自动化脚本或截图计划视为已通过的交互/视觉证据；需在允许运行浏览器的开发环境运行该脚本补齐验证。

## 本次自动化验证结果（2026-10-27）

- 项目 TypeScript 类型检查、全仓 ESLint、Prettier 检查与生产构建：通过。
- 聚焦 UI / 网格 / 面板 / 样式隔离测试：7 个文件，57 项通过。
- 全仓 Vitest（`--maxWorkers=2`）：145 个文件，1589 项全部通过。
- 构建输出保留 SQLite Worker/WASM，组件样式和 Inter 字体均自包含；额外验证工具类前缀、局部初始化与动画命名空间、Portal 容器边界。
- 浏览器交互、焦点、移动端截图及真实 SillyTavern 联调仍未验证；上方环境限制没有被单元测试替代。
