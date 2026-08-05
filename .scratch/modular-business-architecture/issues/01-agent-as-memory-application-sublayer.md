# 01 — Agent 作为 Memory Application 层的 agent 子层

**Type:** task

**What to build:** 把 `core/src/agent` 移入 `core/src/memory/application/agent`,使表格填写 Agent 不再是 peer 业务模块。Agent 的语义（提案、temp id、修订）全部属于记忆领域,其行为是记忆用例的编排;「peer 模块引用 memory 的 application」既不是 bounded context 的 context map,也没有自己的模型（输出就是 `MemoryProposalOperation`）。

**Status:** resolved

## Decision

- Agent 编排（运行、工具调用、模型协作）是 Memory 模块 Application 层的一部分,目录为 `core/src/memory/application/agent`,不建立 peer 业务模块;Retrieval 仍保留未来 peer 模块位置。
- `@earendil-works/pi-*` 与 typebox 是模块内唯一被约束的引擎依赖:只有 agent 子层允许 import,架构测试强制（`core/test/architecture.test.ts` 新增两条规则:引擎依赖隔离 + agent 子层只被自身 import）。
- `core/src/memory/domain` 保持零 pi;ADR-0008/0018 措辞更新为「领域层零 pi + agent 子层是唯一 pi 触点」。
- agent 子层内部 import 直接指向模块内部定义文件（`../domain/index.ts`、`../memory-proposal.ts` 等）,不再走模块公开入口。
- 宿主访问入口:`@ste-memory/core/memory/agent`(core/package.json exports 从 `./agent` 改为 `./memory/agent`)。

## Comments

### 2026-08 讨论要点

- 两个方向原用了两套模式:query 方向 agent 自有 `MemorySpaceReader` 端口(消费方端口),proposal 方向直接持有 `MemoryProposalPorts`(memory 的 repository 依赖包)并调用 application 函数——这是「peer 引用 app 模块」最怪的地方。
- 用 bounded context 标尺量,agent 不是独立上下文:输出类型就是 memory 的类型,校验规则和 temp id 约定都是 memory 的,锁步演化。
- 不采用「泛化 agent 引擎包」:只有一个消费者,按 spec 原则等第二个真实消费者(Retrieval/ST 宿主)出现再提取。
- 修复「agent 持有 MemoryProposalPorts」的问题(宿主组合)留给 modular refactor 落地时处理。

## Answer

已实现:`git mv core/src/agent core/src/memory/application/agent`;10 个文件的 import 从 `../memory/index.ts` 改为模块内部定义文件;`core/package.json` exports `./agent` → `./memory/agent`;apps/api 4 处引用更新;`core/test/architecture.test.ts` 新增两条规则(pi/typebox 仅限 agent 子层、agent 子层只被自身 import);ADR-0008/0018 与 modular-business-architecture spec 更新(Agent 不再是 peer 业务模块,Retrieval 保留);全仓测试/typecheck/lint/prettier 通过。
