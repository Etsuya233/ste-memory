# 跨插件只读接口 v1

初始化完成后，Memory 在 `globalThis.STE_MEMORY_API` 发布正式读取接口，并通过 `window` 派发 `ste-memory:ready`。消费方先检查已有接口，再监听 ready，适配两种加载顺序。调试入口 `__STE_MEMORY_RUNTIME__` 不属于公共契约。

类型定义位于 `src/features/public-read/public-read-api.ts`：

```ts
interface MemoryReadApi {
  readonly version: 1;
  getContext(): MemoryReadContext;
  subscribe(listener: () => void): () => void;
  read(): Promise<{ context: MemoryReadContext; snapshot: MemoryReadSnapshot }>;
}
```

`getContext()` 返回 revision（本次运行中的失效代次）、chatIdentity/chatName、spaceId/spaceName、available 和 message。身份与显示名分离；未就绪、未保存、分支待处理或加载失败时 available 为 false，并提供原因。revision 用于判断读取失效，不是持久版本或内容哈希。

`subscribe` 监听绑定变化及当前空间的 SQLite 已提交资料发布、加载与卸载，返回退订函数。覆盖结构修改、记录增删改及空间恢复；通知直接跟随运行库发布，即使随后缓存或聊天文件保存失败，读取方也会失效。通知不携带增量数据，也不表示聊天文件已成功保存。未提交填表内容不触发公开。

`read()` 在一次 SQLite Worker 调用内取得已提交的 space、tables、fields、records；不分页截断，不包含历史、证据、任务、设置或凭据。表、字段、记录遵循 `features/memory/index.ts` 的领域类型。消费方可依赖字段 ID 对应的 payload 和记录身份，将来源结构转换为自己的业务契约。记录 displayText 可能是保存时计算值，需要当前引用名称时应根据本次快照的显示策略重新展开。

读取前后检查 revision、聊天身份、空间及就绪状态，变化时拒绝结果。消费方仍需在异步调用外跟踪自己的聊天与请求代次，防止已经返回的旧结果覆盖新页面。SQL 控制台直接未保存的调试操作不提供变更通知保证。

接口只暴露读取能力；没有数据库对象、写入方法或任意 SQL 入口。只读快照的修改不会写回 Memory。
