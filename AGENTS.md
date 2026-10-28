## 资源

我们会将一些外部资源存储在 tmp 中，比如 SillyTavern 源码、样例插件源码、文档聊天 JSONL 或角色卡等资源。你可以进行参考。但 Git 文件不要引用他们。

## 开发详情

我们正在开发 SillyTavern 插件。

### 前端开发

修改新前端页面、公共组件、工作区状态、ST 接线或样式时，先阅读
[前端开发规范](docs/ui/frontend-development.md)，按其中的代码入口、复用约定和验收规则实施。
预览环境与各页面验证命令见 [前端开发与验收](docs/ui/frontend-preview.md)。

## Worktree

新建 Git Worktree 时，统一放在主仓库根目录的 `.worktrees/<名称>/` 下；在已有 Worktree 中操作时，仍使用主仓库的该目录。

## Agent skills

### Issue tracker

Issues are tracked as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five canonical triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context layout: vocabulary lives in the root `CONTEXT.md`, decisions in `docs/adr/`. See `docs/agents/domain.md`.
