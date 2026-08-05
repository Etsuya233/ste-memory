# 业务模块与多宿主应用架构

**Status:** ready-for-agent

## Problem Statement

当前 Core 按 Domain 与 Application 横向分层，现有代码全部服务于记忆管理，因此职责暂时清晰。随着 Retrieval 和 SillyTavern 插件加入，以及表格填写 Agent 的编排在 Memory 模块内持续增长，同一组横向目录会混入多个业务模型、用例和端口，调用方也能通过宽泛导出绕过模块公开接口。届时业务所有权、依赖方向和代码导航都会逐渐模糊，后期再移动并同时修改代码还会降低 Git 对文件历史的识别质量。

系统还需要支持多个可执行宿主。HTTP API 由 Fastify 请求驱动，未来的 SillyTavern 插件由 SillyTavern Event 驱动，并可能在浏览器运行时直接装配业务模块。两种宿主拥有不同的 inbound Adapter、配置、生命周期和持久化选择。当前 API 目录同时放置 HTTP 转换、SQLite Adapter、对象装配和部分应用编排，尚未明确区分宿主 Application 层与 Composition Root。

需要建立一套可以渐进演进的模块结构，使记忆管理拥有稳定接口，让不同宿主复用相同业务规则，并为未来 Retrieval 保留清晰位置、为表格填写 Agent 在 Memory 内保留稳定子层，同时避免提前创建没有行为的空模块或引入不必要的进程边界。

## Solution

代码按照“业务模块”和“可执行宿主”两个维度组织。Memory 作为当前唯一业务模块，内部保留 Domain、Application、inbound ports 和 outbound ports；表格填写 Agent 是 Memory Application 层内的 agent 子层（`core/src/memory/application/agent`），不是 peer 业务模块——它的语义（提案、temp id、修订）属于记忆领域，行为是记忆用例的编排。未来 Retrieval 在出现真实模型和用例时建立同级业务模块。每个模块通过单一公开入口暴露用例、命令、查询结果和必要的集成契约，模块内部类型、Repository 与校验实现不向其他模块开放。

API 与 SillyTavern 插件分别作为可执行宿主。宿主拥有自己的 Application 层、technology-specific Adapter 和 Composition Root。宿主 Application 层承载仅对该运行形态成立的流程，例如 HTTP 上传来源文件后的协调流程，或 SillyTavern Event 到达后的会话同步流程；它只能调用业务模块公开接口和宿主自有端口。Composition Root 只读取配置、创建 Adapter、构造业务模块并连接依赖，不包含业务判断。

HTTP 路由和 SillyTavern Event Listener 都作为 inbound Adapter，把外部输入转换为宿主用例或业务模块用例的输入。SQLite、未来的浏览器存储、LLM Provider 和向量索引作为 outbound Adapter。技术专属 Adapter 默认放在使用它的宿主内；出现真实复用后，再提取为独立 Adapter package。

本次只重组现有 Memory 与 API 代码、收紧公开接口并建立依赖约束。Retrieval、Agent、SillyTavern 插件、向量索引和跨进程通信的实际功能将在后续 Spec 中定义。

## User Stories

1. As a maintainer, I want Memory code grouped under one business module, so that I can understand its model without searching across unrelated future capabilities.
2. As a maintainer, I want each business module to have one documented public interface, so that I can identify supported dependencies quickly.
3. As a maintainer, I want internal domain types and persistence ports hidden from unrelated modules, so that refactors remain local to the owning module.
4. As a maintainer, I want Domain and Application separation preserved inside Memory, so that domain rules remain independent from orchestration and I/O.
5. As a contributor, I want future Retrieval code to have a clear peer location, so that indexing and search concepts do not enter the Memory model.
6. As a contributor, I want Agent code to have a clear location inside the Memory module's Application layer, so that runs, tool calls and model interaction do not enter the Memory domain model.
7. As an API developer, I want HTTP routes to call explicit inbound ports, so that request handling contains only transport conversion and response mapping.
8. As a SillyTavern plugin developer, I want SillyTavern Event listeners to drive the same business use cases, so that plugin behavior reuses Memory rules without HTTP.
9. As a SillyTavern plugin developer, I want SillyTavern event names, payloads and lifecycle behavior isolated in an Adapter, so that external platform semantics do not leak into business modules.
10. As a host developer, I want a host-level Application layer for runtime-specific workflows, so that coordination does not accumulate in routes, event listeners or bootstrap code.
11. As a host developer, I want host workflows grouped by business capability, so that the Application layer remains navigable as the host grows.
12. As a host developer, I want the Composition Root limited to configuration and dependency wiring, so that starting the program does not execute hidden business policy.
13. As a Memory consumer, I want to submit changes through Memory commands, so that manual edits, Agent proposals and future adapters obey the same invariants.
14. As a Memory consumer, I want stable query results designed for callers, so that consumers do not depend on Repository interfaces or database-shaped entities.
15. As an Agent developer, I want agent runs to read memory only through a narrow read port and to write only via the proposal pipeline, so that tool code never touches repositories or writes directly.
16. As an integration developer, I want translation Adapters between business modules when their models differ, so that one context does not adopt another context's internal language.
17. As a Retrieval developer, I want indexing failures isolated from Memory commits, so that Memory remains usable while derived indexes are unavailable.
18. As a Retrieval developer, I want Memory changes available through a stable integration contract, so that indexes can be updated or rebuilt without database access.
19. As a persistence developer, I want storage Adapters to implement module-owned outbound ports, so that persistence technology can change without modifying use cases.
20. As a test author, I want to test business behavior through public Application interfaces, so that tests remain stable when internal files move.
21. As a test author, I want to test HTTP and SillyTavern mappings at their Adapter seams, so that transport behavior is verified separately from business rules.
22. As a test author, I want architecture checks that reject forbidden cross-module imports, so that dependency direction is enforced continuously.
23. As a reviewer, I want the structural move separated from behavioral changes, so that Git can recognize file history and the refactor remains reviewable.
24. As a reviewer, I want existing behavior and transport contracts preserved during the move, so that architecture work can be assessed independently from feature work.
25. As a repository user, I want existing API and Web workflows to continue working after the reorganization, so that the refactor causes no user-facing regression.
26. As a future host developer, I want to compose Memory with a different inbound and outbound Adapter set, so that adding a CLI, desktop host or browser host does not require forking the business rules.
27. As a maintainer, I want reusable technology Adapters extracted only after a second real consumer appears, so that the repository avoids speculative packages.
28. As a maintainer, I want cross-module workflows assigned to a natural owning module, so that a generic orchestration layer does not become a collection of unrelated logic.
29. As a maintainer, I want a dedicated workflow module introduced only when a cross-module process gains its own state and lifecycle, so that module boundaries reflect actual business concepts.
30. As a domain modeler, I want architectural documentation aligned with the code structure, so that future decisions about Retrieval, Agent and adapters use consistent vocabulary.

## Implementation Decisions

- Organize the Core by business module first and by technical layer second. Memory contains its own Domain, Application, inbound ports, outbound ports and public entry point.
- Treat Memory as the cohesive owner of memory spaces, table definitions, fields, records, references, evidence and revisions. Do not create a narrower `memory-table` business module.
- Add Retrieval as a peer business module only when its first real use cases are implemented. The table-filling Agent is not a peer business module: its orchestration lives in the Memory module's Application layer under `memory/application/agent`, which is the only place allowed to import the agent engine (`@earendil-works/pi-*`, typebox). This refactor must not create placeholder directories, empty interfaces or speculative implementations for Retrieval.
- Keep business modules in one Core package during this phase. Reassess separate workspace packages when multiple modules exist and compile-time package isolation provides concrete value.
- Replace broad wildcard exports with explicit public module entry points. External callers may import published commands, queries, result views and errors; internal validation functions, Repository interfaces and implementation details remain private unless an Adapter genuinely implements the port.
- Define inbound ports in the Application layer of the module that offers the use case. HTTP routes, event listeners, tests and other driver Adapters call these ports.
- Define outbound ports in the Application layer of the module that needs an external capability. Persistence, model provider, clock, identity generation and integration Adapters implement those ports.
- Use provider-owned integration contracts for stable facts or events published to other modules. When a consumer needs different terminology or a smaller capability, let the consumer own an outbound port and connect it through a translation Adapter.
- Do not allow Retrieval to import Memory repositories, database schema, domain validation helpers or internal entities. Future integrations must use Memory's public Application or integration interface. The agent sublayer lives inside the Memory module and may import its internals, with two hard constraints: the domain layer never imports the agent sublayer, and engine dependencies (`@earendil-works/pi-*`, typebox) are confined to `memory/application/agent`.
- Establish a host-level Application layer inside each executable host. It coordinates runtime-specific flows and imports only public business-module interfaces plus host-owned ports.
- Keep HTTP multipart parsing, status-code mapping, Fastify registration and HTTP DTO conversion in the API inbound Adapter.
- Split the current memory-space upload flow so that SillyTavern JSONL parsing and HTTP source-store concerns stay owned by the API host, while general Memory creation and system-table installation are exposed through a Memory use case.
- Preserve the existing rule that Source Store ownership belongs to the Adapter. The architectural move must not introduce SillyTavern JSONL or source-store types into Memory Domain.
- Place future SillyTavern Event subscription, payload normalization, chat identity mapping, event ordering and platform lifecycle handling in the SillyTavern plugin inbound Adapter.
- Place product policy that reacts to a normalized conversation change in the owning business Application layer. If a cross-module workflow later develops persistent state, retry policy or an independent lifecycle with no natural owner, specify a dedicated workflow module at that time.
- Give each executable host its own Composition Root. It loads configuration, constructs concrete Adapters, creates module use cases, registers lifecycle cleanup and starts the host.
- Prohibit business branching, retries, transaction policy and source-processing decisions inside the Composition Root.
- Keep technology-specific Adapters in the host that uses them. Extract a reusable Adapter package after a second real host consumes the same implementation and its configuration contract is understood.
- Preserve all existing HTTP behavior, persistence schema, transport response shapes and user-visible workflows during this refactor.
- Perform file moves and import/export adjustments as a dedicated structural change. Avoid simultaneous renaming or behavioral rewriting so Git similarity detection can retain useful file history.
- Update architecture and domain documentation where existing statements place all future Agent orchestration in one undifferentiated Application layer. The revised documentation must distinguish business-module Application layers, host Application layers, Adapters and Composition Roots.
- Enforce dependency direction with repository tooling. Domain imports only its own domain code; module Application imports its own Domain and declared ports; host Application imports public module interfaces; Adapters import the interfaces they drive or implement; Composition Roots may import all concrete construction dependencies.
- Avoid a repository-wide shared-contract package. Share only technology-neutral primitives with demonstrated reuse, and keep domain language owned by its bounded context.

## Testing Decisions

- The primary test seam is each business module's public Application interface. Tests exercise complete use-case behavior through this interface and replace outbound ports with focused in-memory Adapters or fakes.
- Domain tests continue to cover pure invariants directly where the invariant has meaningful behavior independent of a use case.
- Existing Memory service and mutation tests provide prior art for verifying record validation, reference safety, revision conflicts and atomic mutation behavior. Preserve their behavioral assertions while updating imports and construction.
- Existing API integration tests provide prior art for driving the HTTP Adapter through a constructed Fastify server backed by SQLite. They must continue to verify current request, response and persistence behavior after the move.
- Add architecture tests or lint rules that fail when a business module imports another module's internals, a Domain imports Application or infrastructure code, a host Application imports Adapter implementations, a non-bootstrap file acts as a Composition Root, or code outside `memory/application/agent` imports the agent engine (`@earendil-works/pi-*`, typebox).
- Add a focused test for the host workflow that creates a Memory space from an uploaded source, proving that parsing failures, system-table installation and Source Store persistence retain their current externally visible behavior.
- Test HTTP request conversion separately from Memory business behavior where the mapping has independent rules, including multipart parsing, filename validation and transport error mapping.
- Future SillyTavern Adapter tests will use synthetic normalized Event payloads at the Adapter seam; they are documented here as the intended seam and are outside this implementation.
- Do not assert directory names, private class construction order or internal helper calls. Tests should observe returned results, persisted state, emitted integration facts and rejected invalid operations.
- Run type checking, linting, formatting checks, unit tests, API integration tests and the production build after the structural migration.
- A successful refactor leaves all existing behavior tests passing and adds dependency enforcement that demonstrates the intended architecture can no longer be bypassed accidentally.

## Out of Scope

- Implementing Retrieval, RAG, embeddings, vector storage, indexing or semantic search.
- Implementing the table filling Agent, Agent runs, tool calls, prompts, model-provider integration or background task lifecycle.
- Implementing the SillyTavern frontend plugin, Event subscriptions, real-time synchronization or Prompt injection.
- Selecting persistence technology for a browser-hosted SillyTavern plugin.
- Introducing microservices, network calls, message brokers, distributed transactions or separate databases per bounded context.
- Splitting every business module into its own workspace package during this phase.
- Creating a generic event bus or workflow engine before a real cross-module lifecycle requires one.
- Changing Memory domain behavior, SQLite schema, HTTP endpoints, Web UI behavior or existing external contracts.
- Completing deferred Memory Table features from the existing product Spec.
- Refactoring unrelated Web presentation code.

## Further Notes

The word `application` has two valid scopes in this architecture. A business-module Application layer implements use cases for one bounded context. A host Application layer coordinates workflows that exist because of a particular executable runtime. The `apps` directory names deployable hosts and does not replace either business Domain or business Application logic.

The desired dependency shape is asymmetric at runtime: Memory owns authoritative state; future Retrieval consumes a rebuildable projection; the agent sublayer consumes Memory capabilities through the module's own Application internals. At source level, a host integration Adapter may depend on both public interfaces while the business modules remain unaware of each other's internals.

The existing API bootstrap already approximates a Composition Root. The current memory-space manager contains a mixture of host workflow, source parsing and Memory coordination, making it the main candidate for responsibility separation during this refactor.

No ADR is required solely for moving files. If the implementation formalizes the long-term rule that multiple hosts compose the same business modules and that technology-specific Adapters belong to hosts by default, update or supersede the existing Agent architecture decision because future maintainers would otherwise receive conflicting guidance.
