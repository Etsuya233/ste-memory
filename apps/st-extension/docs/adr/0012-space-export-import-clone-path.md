# ADR 0012 — 单空间导入：cloneSpace 路径选择

## Status

Accepted（issue 26 已实现：resolveImportAction 纯函数 + cloneSpaceFromUnit 仓库方法 + ChatSpaceManager.importSpace）

## Context

issue 26 引入单空间导出/导入功能。核心设计问题：当导入文件的 spaceId 与当前空间不一致时，应该怎么处理？

三个候选方案：

1. **Remap 写入**：把文件数据的 ID 全部重映射到当前空间的身份下（spaceId = 当前空间），直接写入替换当前空间的现有数据。
2. **CloneSpace + 重建绑定**：用文件数据 clone 出新空间（全新 ID，所有外键重映射），然后把当前对话的绑定指向新空间。原空间保留不动。
3. **拒绝不匹配文件**：只允许导入 spaceId 匹配的文件，不匹配时报错。

## Decision

选择方案 2：**CloneSpace + 重建绑定，保留原空间**。

## Rationale

### 为什么不选 Remap 写入

Remap 写入看似直接（「把文件数据塞进当前空间」），但有两个问题：

1. **破坏引用关系**：当前空间的 spaceId 已经被云同步的 fingerprint、对话文件镜像、对话绑定等外部系统引用。Remap 写入保留了 spaceId 但替换了全部内容，导致这些外部引用指向「内容已变但身份未变」的空间——语义上是「偷梁换柱」，与 LWW 冲突裁决的前提（同一实体的不同版本）矛盾。

2. **不可逆**：原空间数据被覆盖后无法恢复。CloneSpace 路径保留原空间，用户可以对比后手动清理。

### 为什么不选拒绝不匹配

拒绝太严格。用户从分支 A 导出、在分支 B 导入是合理场景（grilling session 确认的核心用例）。强制用户先对齐 spaceId 再导入增加了不必要的摩擦。

### CloneSpace 的优势

1. **安全**：原空间数据不动，新空间独立存在，最坏情况是多一个孤儿空间（可手动删除）。
2. **复用已有基础设施**：`MemoryBackupRepository.cloneSpace` 已实现完整的 ID 生成 + 外键重映射 + 事务原子写入，无需新增核心逻辑。
3. **与分支对话分离同模式**：`ChatSpaceManager.resolveBranch` 已经用 cloneSpace 处理分支对话的克隆，导入路径与之对齐。

### 保留原空间的理由

cloneSpace 创建新空间后，原空间保留而非删除。理由：

- 用户可能在多个对话中共享同一空间（复制的对话文件共享绑定），删除会影响其他对话。
- 「抄了一份」比「搬了家」更符合用户对「导入」的心理模型——导入不意味着迁出。
- 清理原空间是独立操作（删除记忆空间），不需要在导入流程中耦合。

## Consequences

- 导入不匹配文件后，本地会多一个空间（原空间 + 新空间）。这是预期行为，不是泄漏。
- `resolveImportAction` 纯函数需要知道当前 spaceId 才能判断匹配/不匹配，UI 层从 `ChatSpaceManager.getStatus()` 获取。
- CloneSpace 路径需要 ID 工厂和空间重命名，复用 `ChatSpaceManager.resolveBranch` 的已有模式。
