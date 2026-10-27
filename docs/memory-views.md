# 表达式宏

在设置的「记忆宏」中创建宏，把 `{{ste::宏名}}` 放进角色卡、提示词预设或世界书内容。`ste` 是可修改的默认前缀。无参宏保留全部启用表摘要，`full` 输出完整表格，表 Key 可直接作为单表宏名。

界面提供对话宏、全局宏、内置宏。对话宏保存在当前绑定记忆空间中，表格预设可携带这些定义；共享空间的对话也共享定义，各次执行仍使用自己的消息输入。同名优先级为对话、全局、内置，停用或错误的高层宏仍占位，删除后才会使用低层同名宏。

## 配置 Query

宏默认采用 Query，表与字段填写实际定义 Key。条件数组为 AND，算子和字段类型沿用记忆查询。字段、排序和条数都由表达式决定：

```json
{
  "table": "chronicle",
  "conditions": [{ "field": "plot_summary", "op": "equals", "value": null }],
  "fields": ["summary", "details"],
  "orderBy": { "field": "$created_at", "direction": "asc" },
  "limit": 15
}
```

需要按当前用户消息的相关度排序时，添加 semantic，并使用 `$similarity`。组填写向量组 Key，界面帮助区列出当前表字段和组：

```json
{
  "table": "chronicle",
  "semantic": {
    "groups": ["event_memory"],
    "query": { "context": "last_user_message" }
  },
  "conditions": [
    { "field": "plot_summary", "op": "equals", "value": null },
    { "field": "$similarity", "op": "greater_than_or_equal", "value": 0.3 }
  ],
  "fields": ["summary", "details", "$similarity"],
  "orderBy": { "field": "$similarity", "direction": "desc" },
  "limit": 10
}
```

`limit` 限制最终查询结果，内部读取不会隐含只取前 100 条。未指定 fields 时使用记录显示文本；引用字段按本批记忆解析为显示值。Query 支持单表和单排序字段，需要 OR、关联、聚合及跨表组合时使用 SQL。

## 配置 SQL

SQL 编辑页直接填写 SQL 正文。通过原生表值函数 `semantic_scores(table_key, groups_json, query_text)` 引用语义评分：三个参数依次为表 Key、向量组 Key 的 JSON 数组和查询文本。它提供 `record_id`、`score`、`group_key`，每条记录取多个组中的最高分，不预先截取 Top K。

```sql
SELECT c."summary", c."details", s.score
FROM "chronicle" AS c
JOIN semantic_scores(
  'chronicle',
  '["event_memory"]',
  :last_user_message
) AS s ON s.record_id = c."$record_id"
WHERE c."plot_summary" IS NULL AND s.score >= 0.3
ORDER BY s.score DESC, c."$record_id" ASC
LIMIT 10;
```

SELECT 决定字段，WHERE 决定条件，ORDER BY 和 LIMIT 决定最终顺序与条数。多个调用可通过 JOIN、UNION 或 CTE 组合；SQL 也可以返回无记录身份的聚合结果。多组选取可写 `json_array('event_memory', 'summary')`，组必须是当前表实际配置的 Key。普通 SQL 不调用该函数即可。

无有效向量的记录在评分源中没有行，LEFT JOIN 可以保留业务记录并得到 NULL 分数。源为空仍执行 SQL，例如 COUNT 可返回零。缺表缺组、输入错误或实际 embedding 失败会使所属宏为空，错误在面板显示。评分源只读取有效索引，不等待或触发补建。

第三个参数也可以写固定文本。`:last_user_message` 使用最后已保存用户消息，仅去除首尾空白；不展开宏、不拼历史、不调用 LLM 改写。没有用户消息时为 NULL，将 NULL 传入函数会报告输入错误。SQL 只允许一条只读查询，禁止写入、PRAGMA、事务和内部表读取；重复输出列需要起不同别名。宏、查询 Agent 与控制台共用语义执行器。

函数允许 SQLite 表达式和有界行关联参数。缺少某个评分源时，本轮 SQL 中断并丢弃部分结果，异步准备后从头执行；只发布完整成功轮。单条内联 SQL 最多 16 个不同评分源、4 种 trim 后的查询文本和 17 轮，SQL 时间累计计算。随机生成参数可能持续产生新输入，最后超限报错，之前已发出的少量请求可能计费。

## 执行、测试与预算

每个宏只有一个启用开关。新建或从预设、备份、克隆得到的语义宏默认停用，启用后每次适用的实际生成都会计算，即使未在提示词中放置。全局宏的开关作用于所有适用对话。

所有启用宏在本次提示词展开前统一计算；保存配置、编辑记忆、切对话、刷新与补建索引不预先求值。重生成、swipe、续写重新计算；群聊同批、工具递归和重复宏调用复用本批结果。记录以批次开始时的已提交输入为准，后续修改用于下一批。

同一批次相同文本和连接配置共享查询向量请求。成功向量另有 5 分钟绝对 TTL、64 项、8 MiB 载荷的内存 LRU，跨生成及显式测试可以命中；读取不延长 TTL。凭据、模型、端点及维度配置变化隔离缓存。只缓存查询向量，记录评分和 SQL 输出随新快照重新计算；失败、取消和迟到响应不写入成功缓存。

最近结果展示实际表达式、输入、索引覆盖、时间、SQL 轮数、准备源数、批次查询向量请求及缓存命中、返回和输出数量、错误及文本，打开它不会重新计算。批次请求统计不能在多个宏之间重复相加。测试可手工提供用户消息，单独执行且不覆盖真实生成结果。计算中可跳过，ST 停止和切对话取消旧批次，迟到响应不会回填。

默认总等待上限为 10 秒，SQL VM 上限 1 秒，最终结果最多 10,000 行；超限报错。输出字符预算按完整记录或结果行装入，并标记省略；JSON 保持有效结构。语义源评分量不受最终结果条数截断，大数据集可能先触及时间或内存限制。

ST 在保存新用户消息前就会展开其中的宏，因此本次直接输入在用户正文中的记忆宏无法取得其后计算的结果。独立 dry run、quiet 和 impersonate 不触发宏计算；宿主没有提供完整操作身份，并发 dry run 或 quiet 可能读取正常生成中的本批文本。等待阶段的这些调用不会撤销正常批次；已进入提示词构建后的无身份结束事件仍存在宿主归属限制。

取消门禁须先于其他可能提前终止生成的扩展执行。本插件使用 `loading_order: -1000`；若第三方扩展使用更低数值并提前终止拦截器链，需要调整加载顺序，否则停止后的下一次发送可能等待旧调用退出。

## 旧配置与预设

旧全局视图转成 Query 宏，原未填条数按旧实现固定为 100。旧聊天 metadata 宏迁入绑定空间，原数据在完成前保留；共享空间发生同名不同定义时，界面要求选择保留、覆盖或改名，冲突仅阻止该对话对应名称。

表格预设可新增、编辑和导出对话宏，应用时与结构一起复制，之后独立维护。语义组按稳定 Key 对应，新副本产生新宏身份；SQL 字面值保持原样，不自动搬运记录或重写记录 ID。预设宏可在空结构与空评分关系上做只读编译校验，不调用 embedding。

已有非空 `sources + sql` 宏继续兼容执行，旧 SQL 和来源 JSON 完整保留并只读展示，名称、启用及输出设置仍可修改。通过“转换为内联 SQL 草稿”手工修改表达式后保存；转换失败保留旧定义。系统不会自动替换来源名称，以免改坏 CTE 或别名。旧格式不与新内联函数混用，继续沿用原有预算。

旧自动召回设置、绑定和 `{{memoryRecall}}` 专用入口整块移除，不提供别名或转换器。旧提示词引用需要自行改成表达式宏；手动向量检索和索引保留。

## 宏召回的 rerank

语义 Query 和内联 SQL 均可使用共享重排能力，默认跟随全局「重排连接」开关。
Query 的 `semantic.options` 对应 SQL 的第四个 JSON 参数：

```json
{
  "table": "events",
  "semantic": {
    "groups": ["event_memory"],
    "query": { "context": "last_user_message" },
    "options": { "candidateLimit": 50, "textFields": ["summary", "details"] }
  },
  "conditions": [{ "field": "character", "op": "equals", "value": "林舟" }],
  "fields": ["summary", "details"],
  "orderBy": { "field": "$rank", "direction": "asc" },
  "limit": 10
}
```

启用重排时，Query 编译器先执行普通业务条件，形成 scope；评分条件在评分完成后执行。
关闭重排时，普通业务条件由最终 SQL 筛选，不增加候选 ID 预查询，也不引入其范围上限；显式 `scopeRecordIds` 仍然有效，覆盖统计按实际评分范围计算。
显式 `scopeRecordIds` 与业务范围取交集。`candidateLimit` 控制中间候选，`limit` 保持最终结果上限。
语义 Query 未指定排序时使用 `$rank` 升序；已有显式排序保持原样。
`$similarity` 保持余弦含义，新增 `$rerank_score`、`$rank` 可用于投影、条件和排序。
Query 自动排除当前 `rank` 为 NULL 的记录；重排关闭时全部有效记录都有向量名次。
普通非语义宏不触发重排。

真实生成先固定记忆与连接快照，完成 Query/SQL 的评分和重排后，再渲染最终行并按字符预算装入宏文本。
角色卡、预设和世界书中的 `{{ste::宏名}}` 读取本批最终文本。重生成重新计算，群聊同批复用，
停止或切对话不发布旧结果。测试使用同一执行链路，但不覆盖真实生成结果。
新增和恢复的语义宏仍默认停用；启用的宏即使没有被提示词引用也会计算。

SQL 简写、高级范围和分数契约详见[共享语义 SQL](./semantic-sql.md#可选-rerank)。
