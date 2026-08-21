## 资源

我们会将一些外部资源存储在 tmp 中，比如 SillyTavern 源码、样例插件源码、文档聊天 JSONL 或角色卡等资源。你可以进行参考。但 Git 文件不要引用他们。

## 开发详情

我们正在开发 SillyTavern 插件。

## Agent skills

### Issue tracker

Issues are tracked as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five canonical triage labels are used. See `docs/agents/triage-labels.md`.

### Domain docs

This is a multi-context layout using root `CONTEXT-MAP.md` and per-context `CONTEXT.md` files (core owns the domain glossary; apps is shared by api + web). See `docs/agents/domain.md`.
