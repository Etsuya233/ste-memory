# STE Memory — SillyTavern 插件发布分支

本分支是**构建产物**，由 `scripts/release-st.mjs` 从主仓库重生成，请勿直接修改或提交 PR。
源代码与 issue 追踪：<https://github.com/Etsuya233/ste-memory>

## 安装（SillyTavern）

扩展 → Install extension：

- **URL**：`https://github.com/Etsuya233/ste-memory`
- **Branch or tag name**：`release/sillytavern-plugin`
- 安装时勾选“Install for all users”（可选，仅管理员）

更新：扩展面板点 **Update**（本分支 push 新 commit 后即可见）；
或把 manifest.json 的 "auto_update" 字段改为 true 开启每日自动更新检查。

## 当前版本

- 版本：0.1.3
- 源提交：479ba56（feature/sillytavern-plugin）

## 卸载

扩展面板中把 **STE Memory** 设为禁用，或直接删除
`public/scripts/extensions/third-party/ste-memory` 目录后刷新页面。
