# 使用 TypeScript 单仓库实现首个实验

首个实验使用 TypeScript 单仓库。根级 `core` 包按业务模块优先、技术分层其次的方式组织；当前只有 `memory` 模块，未来 Retrieval 和 Agent 在拥有真实模型与用例后再建立同级模块，暂不拆成独立发布单元。HTTP、Web 等业务接入 Adapter 位于 `apps`，每个可执行宿主拥有自己的 Application 流程和 Composition Root；API 宿主拥有数据库 schema、迁移、持久化 Adapter 和连接生命周期。`packages/tools` 保存可供不同宿主复用的平台无关接口，当前包含异步 Unit of Work；共享工程配置位于 `packages/shared`。SillyTavern 的 JavaScript 生态可以复用类型和契约，其 Adapter 保持在业务模块之外。项目通过 mise 固定 Node.js 与 pnpm 工具版本。
