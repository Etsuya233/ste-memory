# 使用 TypeScript 单仓库实现首个实验

首个实验使用 TypeScript 单仓库。根级 `core` 包内部按目录组织纯领域模型、应用用例及其 Ports，避免把同一个核心边界拆成多个发布单元；HTTP、Web 等业务接入 Adapter 位于 `apps`，Core SQLite 持久化与通用 SQLite 能力合并为 `packages/core-sqlite`，共享工程配置位于 `packages/shared`。SillyTavern 的 JavaScript 生态可以复用类型和契约，但其 Adapter 保持在 Core 之外；这种组织支持快速验证，同时让未来插件接入不需要复制业务规则。项目通过 mise 固定 Node.js 与 pnpm 工具版本。
