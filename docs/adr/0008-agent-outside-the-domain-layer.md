# 表格填写 Agent 位于领域层之外

采用按业务模块组织的 Hexagonal Architecture：Memory 模块的领域层拥有表格模型、字段校验、引用约束和修订规则，Memory Application 层拥有记忆用例和写入 Ports；表格填写 Agent 的编排（运行、工具调用和模型协作）位于 Memory Application 层内的 agent 子层（`core/src/memory/application/agent`），不单独建立 peer 业务模块——Agent 的语义（提案、temp id、修订）全部属于记忆领域，其行为是记忆用例的编排。API、SillyTavern、LLM Provider 和持久化均属于各自宿主或模块的 Adapter。

Agent 可多次使用只读查询工具，但所有写入汇总为一个与模型无关的跨表原子批次，并通过 Memory 的公开 Application interface 提交。Tools 和结构化 DSL 均编译到这一命令，不直接写库。宿主 Application 层只协调运行形态专属流程，Composition Root 只负责依赖装配。
