# 使用 TypeScript 单仓库实现首个实验

首个实验使用 TypeScript 单仓库。根级 `core` 包内部按目录组织纯领域模型、应用用例及其 Ports，避免把同一个核心边界拆成多个发布单元；HTTP、Web 等业务接入 Adapter 位于 `apps`，API App 拥有数据库 schema、迁移、持久化 Adapter 和连接生命周期。`packages/tools` 保存可供不同宿主复用的平台无关接口，当前包含异步 Unit of Work；共享工程配置位于 `packages/shared`。SillyTavern 的 JavaScript 生态可以复用类型和契约，其 Adapter 保持在 Core 之外。项目通过 mise 固定 Node.js 与 pnpm 工具版本。
