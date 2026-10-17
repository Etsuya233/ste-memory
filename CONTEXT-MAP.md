# Context Map

本仓库是**单上下文**布局：一个 SillyTavern 记忆插件（源码在根 `src/`），
领域词汇与插件词汇合并在根目录 `CONTEXT.md` 中，跨结构决策放在根目录
`docs/adr/`。

## Contexts

- **ste-memory**（`src/`）：唯一上下文。领域词汇（记忆表格、证据、修订、记忆空间……）
  与插件词汇（同步楼层、记忆宏、填表任务、问答面板……）都在 `CONTEXT.md` 定义。

## Rules

- 领域词汇只在 `CONTEXT.md` 中定义一次；`src/` 下的功能模块不重复定义。
- 结构约束与导入方向由 `tests/architecture/` 与 ESLint 强制（见 `docs/refactor-plan.md`）。
- 历史多上下文决策（core / apps / st-extension 划分）保留在 `docs/adr/`，已废弃的
  条目在文首标注「已废弃（被取代）」。
