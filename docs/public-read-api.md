# 跨插件只读接口 v1

初始化完成后，Memory 在 `globalThis.STE_MEMORY_API` 发布正式读取接口，并通过 `window` 派发 `ste-memory:ready`。消费方先检查已有接口，再监听 ready，适配两种加载顺序。调试入口 `__STE_MEMORY_RUNTIME__` 不属于公共契约。

类型定义位于 `src/features/public-read/public-read-api.ts`：

```ts
interface MemoryReadApi {
  readonly version: 1;
  readonly database?: MemoryDatabaseApi; // capability version 1
  getContext(): MemoryReadContext;
  subscribe(listener: () => void): () => void;
  read(): Promise<{ context: MemoryReadContext; snapshot: MemoryReadSnapshot }>;
}
```

`getContext()` 返回 revision（本次运行中的失效代次）、chatIdentity/chatName、spaceId/spaceName、available 和 message。身份与显示名分离；未就绪、未保存、分支待处理或加载失败时 available 为 false，并提供原因。revision 用于判断读取失效，不是持久版本或内容哈希。

`subscribe` 监听绑定变化及当前空间的 SQLite 已提交资料发布、加载与卸载，返回退订函数。覆盖结构修改、记录增删改及空间恢复；通知直接跟随运行库发布，即使随后缓存或聊天文件保存失败，读取方也会失效。通知不携带增量数据，也不表示聊天文件已成功保存。未提交填表内容不触发公开。

`read()` 在一次 SQLite Worker 调用内取得已提交的 space、tables、fields、records；不分页截断，不包含历史、证据、任务、设置或凭据。表、字段、记录遵循 `features/memory/index.ts` 的领域类型。消费方可依赖字段 ID 对应的 payload 和记录身份，将来源结构转换为自己的业务契约。记录 displayText 可能是保存时计算值，需要当前引用名称时应根据本次快照的显示策略重新展开。

读取前后检查 revision、聊天身份、空间及就绪状态，变化时拒绝结果。消费方仍需在异步调用外跟踪自己的聊天与请求代次，防止已经返回的旧结果覆盖新页面。SQL 控制台直接未保存的调试操作不提供变更通知保证。

接口只暴露读取能力；没有数据库对象或业务写入方法。只读快照的修改不会写回 Memory。

## 已提交数据库查询能力

`database` 是可选的 v1 能力，类型位于 `src/features/public-read/database-api.ts`。消费方检查能力存在后，先绑定 `getContext()` 返回的 `chatIdentity` 和 `spaceId`，调用 `describe(binding)`。结果只有 `space`、启用的 `tables`/`fields`、可查询的 `columns`，以及不透明的 `schemaKey` 和 `databaseKey`；不会复制记忆记录、历史或证据。停用表和字段不对外开放。

`columns[table.key]` 列出物理业务表可以公开查询的列，包括 `$record_id`、`$display_text`、`$created_at`、`$updated_at` 和启用字段的 Key。列表、多选和多引用列沿用运行库的 JSON 文本表示。`$display_text` 是最近提交时保存的显示值；需要即时展开引用名称的适配器可通过公开字段自行组合 SQL。内部 `__entities`、关系辅助表、SQLite 结构表均不可读。

`schemaKey` 包含空间身份与名称、表和字段的完整结构语义，含标签、顺序、引用与显示策略，排除创建和更新时间。记录提交不会改变它。`databaseKey` 在每次加载或重新导入空间时改变，普通记录发布期间保持不变。适配器以 `databaseKey + schemaKey` 判断是否需要重新注册视图，不能只以空间身份缓存注册状态；切换对话后回到原空间可能已经卸载过运行库。

消费方持有自己的业务映射，Memory 只接受通用的临时 SELECT 视图定义：

```ts
const binding = { chatIdentity: context.chatIdentity, spaceId: context.spaceId };
const schema = await api.database.describe(binding);
const source = { ...binding, schemaKey: schema.schemaKey, namespace: "example_adapter" };
await api.database.registerViews({
  ...source,
  views: [
    { name: "adapter_people", select: 'SELECT "$record_id" AS id, name FROM characters' },
  ],
});
const result = await api.database.query({
  ...source,
  sql: "SELECT id, name FROM adapter_people WHERE name LIKE :name LIMIT 20",
  params: { name: "%Alice%" },
});
```

`registerViews` 原子替换该空间和 namespace 的全部视图；空列表清除该 namespace 的视图。定义只有 `name`、`select` 及可选 `columns`，按依赖顺序注册，允许引用此前定义的同 namespace 视图。namespace 是可信适配器间的命名归属，视图名称在整个空间内按 SQLite 大小写规则唯一；支持正确引用的中文或含引号名称。内部保留名称、其他 namespace 和任何实际业务表（含停用表）发生冲突时明确报错，无法覆盖或写入业务表。注册时与查询时均以 SQLite authorizer 检查展开后的源表和源列，视图无法绕过停用字段或内部元数据限制。

`query` 直接访问当前空间既有的 committed SQLite 实例，可查询公开业务表及当前 namespace 的视图。每次查询不建立完整快照数据库。未提交填表数据不会出现；手动编辑、手动或自动填表提交后的下一次查询会读取新的 committed 数据。每次 publish 在新的 committed 实例重建有效视图，表结构变化使旧注册失效并要求重新 describe/register，消费方的陈旧映射不会阻断 Memory 提交。接受弱一致性，连续查询之间可能出现新的记录提交，没有固定历史会话或记录 revision 锁定。

只允许一条只读 SQL，支持 SELECT、CTE、JOIN、JSON 函数与聚合。原生 prepare、authorizer 和 progress handler 拒绝写入、DDL、PRAGMA、ATTACH、事务控制、内部/危险函数及多语句。参数必须是 `:name`，`params` 的键省略冒号，值只接受字符串、有限数值或 NULL，漏传、未使用或位置参数会报错。默认最多 200 行、750ms；可显式设置 `maxRows` 1–10000、`budgetMs` 1–5000。SQL 文本上限 128 KB，单个参数或结果值上限 1 MB，结果上限 2 MB；超出大小或时间预算报错，后续查询仍可继续。

结果为 `{ columns, rows, elapsedMs, truncated, maxRows }`，行按列顺序返回二维标量数组。64 位整数超出 JavaScript 安全范围时转为十进制字符串；BLOB 需在 SQL 中自行转换。超过行数上限时返回前面的行并置 `truncated: true`，消费方自行选择分页或汇总。

每次操作在确保运行库就绪之前、之后及异步结果返回时校验聊天和空间绑定；旧对话请求会明确拒绝。记录发布只触发订阅通知，不使同结构下的查询失败。消费方仍需约束自己的页面请求代次。视图注册仅保存在 Worker 内存，空间卸载/删除时清除，不进入备份、缓存快照或聊天文件。Memory 不内置消费方的业务 schema，也不授予消费方任意 host SQL 写权限；现有 `read()` 和订阅行为保持兼容。

## 本轮验证（2026-10-30）

相关 81 项测试通过，覆盖真实 WASM 只读授权、命名参数、截断/超时、committed 隔离、普通发布后视图恢复、结构变化失效、卸载重载及公开绑定；数据库加载标识兼容调整后，5 项数据库测试及生产构建再次通过。

与 Phone 在隔离 ST dataRoot 联调通过：适配器注册标准视图，普通记录与 Agent 提案提交后直接查询新值，普通记录变化不要求重新注册，字段标签变化重新注册；切换聊天和切回后正常查询。接口计数确认 Phone 未调用全量 read，生产无额外 Phone Worker/WASM 请求，无页面错误或模型请求。Agent 提交验证使用隔离提案，未请求模型运行自动填表。未修改用户聊天；未验证真实移动设备与 semantic 公共接口。
