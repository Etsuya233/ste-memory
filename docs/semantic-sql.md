# 共享语义 SQL

宏 SQL、查询 Agent 和手动 SQL 控制台共用 `features/semantic-query`。
`semantic_scores(table_key, groups_json, query_text)` 返回 `record_id`、`score`、`group_key`，
按记录取所选组的最高余弦相似度；评分源覆盖所选范围全部有效索引，最终条数、阈值、关联和排序由 SQL 决定。
可选第四参数控制 rerank，三参数调用跟随全局重排开关。

```sql
SELECT t."$display_text", s.score, s.group_key
FROM "events" t
JOIN semantic_scores('events', json_array('event_memory'), '古桥事故的线索') s
  ON s.record_id = t."$record_id"
WHERE s.score >= 0.3
ORDER BY s.score DESC
LIMIT 10;
```

表与组 Key 使用当前空间的实际配置。查询只读取已有有效索引，不触发补建；覆盖信息区分缺失、过期和
无效索引，零命中并不代表记忆中没有相关事实。

## 使用入口

宏沿用 `:last_user_message`、同轮批次和旧 sources 格式。查询 Agent 的 `query_sql` 同时执行普通 SQL 和
含 `semantic_scores` 的查询；工具说明提供可用表、组和组内字段。调用仍只需传入 `sql`，
在 SQL 内填写查询文本，无需选择独立语义工具，不自动读取 ST 输入或宏上下文。
每次最多返回 100 行，记录按列名组织，并提供列顺序、截断标记、索引覆盖与执行诊断。
填表 Agent 保持原有工具参数、结果及事务读视图。

控制台直接执行普通 SQL 或含 `semantic_scores` 的查询，无需切换模式。右侧保留运行库结构和可用向量组，
点击组生成示例，然后填写查询文本。控制台不自动读取对话消息，也不提供宏的 `:last_user_message` 参数。

SQLite 编译每条语句时识别实际语义依赖；字符串或注释中的函数名不会触发检索。
普通 SQL 按原权限执行，遇到语义查询时暂停，基于新的记忆快照准备评分并执行该只读查询，再继续剩余语句。
已经执行的普通写入不会重跑；含语义依赖的写入（包括触发器中的依赖）在执行前拒绝。
语义查询仍仅访问启用的记忆表与字段，临时创建的任意运行库对象不进入该隔离快照。
每条语义查询最多返回 10000 行，超限报错；支持取消，切对话取消在途准备。
多语句沿用控制台原有的逐条执行语义，后续语句失败时，前面已执行的语句保持原有事务状态。

## 缓存与执行边界

同批次共享相同查询文本的在途请求及成功向量，相同表、组顺序、选项与文本共享评分。
跨批次仅共享成功查询向量，默认有效期 5 分钟、最多 64 条、估算载荷 8 MiB，按 LRU 淘汰；
命中不延长有效期。缓存位于页面内存，刷新清空；连接配置（含凭据）变更会隔离旧缓存。
不同工具调用的在途请求各自拥有取消范围，不跨调用合并；失败、取消和失效配置的迟到向量不进入成功缓存。
记录、评分和 SQL 输出随新快照重新计算。

每次语义执行最多等待 10 秒，各轮 SQL 累计最多 1 秒，最多 16 个不同评分源、4 种查询文本和 17 轮。
共享语义执行器每次处理一条只读查询，SQLite authorizer 拒绝写入、事务、PRAGMA、内部表及停用字段；
控制台中其他普通语句保留原有权限。
缺源时丢弃该轮中间结果，异步准备后重新执行同一 SQL，仅返回完整成功轮。取消和超限可能已有向量请求发出，
错误诊断保留实际请求数与缓存命中。查询 Agent 的总运行取消也会传给正在执行的工具。

## 可选 rerank

在设置的「重排连接」保存独立的 Cohere 兼容连接，填写完整 `/rerank` 端点、密钥和模型。
服务需允许 ST 站点跨域访问；密钥明文保存在插件设置中。旧设置默认关闭，默认候选数量为 50。
修改连接或默认值作用于后续会话；切换 rerank 模型无需重建向量。

简单写法跟随全局开关：

```sql
SELECT e."$display_text", s.score, s.rerank_score
FROM events e
JOIN semantic_scores('events', json_array('event_memory'), :last_user_message) s
  ON s.record_id = e."$record_id"
WHERE s.rank IS NOT NULL
ORDER BY s.rank
LIMIT 10;
```

`:last_user_message` 由宏提供；控制台和 Agent 使用显式查询文本或实际命名绑定参数。
第二参数是向量组 Key 的 JSON 数组，也可写 `'["event_memory","summary_memory"]'`。
组顺序保留；同记录取最高余弦分，去重后仅作为一个重排候选。

第四参数是可选 JSON 对象，未知选项或无效类型会报错：

| 选项             | 含义                                    | 缺省                             |
| ---------------- | --------------------------------------- | -------------------------------- |
| `rerank`         | 本次启用或关闭重排，布尔值              | 跟随全局开关                     |
| `candidateLimit` | 范围内按向量排名选取的重排候选数，1–200 | 全局默认 50                      |
| `textFields`     | 重排文本使用的非空、不重复字段 Key 数组 | 所选组字段按组和组内顺序合并去重 |
| `scopeRecordIds` | 业务范围记录 ID 集合，最多 10000 项     | 整表；空数组为空范围             |

```sql
-- 单次关闭；不截断完整向量评分集合
SELECT * FROM semantic_scores('events','["event_memory"]','古桥线索','{"rerank":false}');

-- 自定义候选数与重排文本
SELECT * FROM semantic_scores('events','["event_memory"]','古桥线索',
  '{"rerank":true,"candidateLimit":100,"textFields":["summary","details"]}');
```

`candidateLimit` 控制送去重排的中间候选，外层 `LIMIT` 控制最终结果。关闭重排时不执行候选截断和文本组装。
`textFields` 从同一记忆快照读取，字段名与值组成带表名的文本；引用字段展开为显示文本，空值省略。
选中字段全部为空、引用损坏或输入超限直接报错，不静默裁剪。最终 `SELECT` 可以只输出摘要。

### 先限定业务范围

外层 `WHERE` 不会限定函数内部候选。需要先从某个角色的事件中选候选时，传入 scope：

```sql
WITH eligible AS MATERIALIZED (
  SELECT * FROM events WHERE character = '林舟'
)
SELECT e.summary, e.details
FROM eligible e
JOIN semantic_scores(
  'events', json_array('event_memory'), :last_user_message,
  json_object(
    'scopeRecordIds', json((SELECT json_group_array("$record_id") FROM eligible)),
    'candidateLimit', 50
  )
) s ON s.record_id = e."$record_id"
WHERE s.rank IS NOT NULL
ORDER BY s.rank
LIMIT 10;
```

执行次序为业务范围 → 有效向量 → 记录最高余弦分 → 向量前 K 条 → 重排 → 外层 SQL。
范围内向量排名在 K 之后的记录无法通过 rerank 找回。scope 去重、按 ID 排序后参与评分源键；
组和重排字段顺序保留。物化 CTE 仅在当前 SQL 轮内有效，变化的动态输入仍受源数和轮数限制。

### 返回列与兼容

评分源继续返回 scope 内全部有效记录，不因重排候选截断而改变关系成员。

| 列             | 语义                                                |
| -------------- | --------------------------------------------------- |
| `record_id`    | 记录身份                                            |
| `score`        | 原有最高组余弦分                                    |
| `group_key`    | 取得最高余弦分的组                                  |
| `rerank_score` | 重排模型分数；未参与者和关闭重排时为 NULL           |
| `rerank_rank`  | 本次重排集合中的名次，从 1 开始；未参与者为 NULL    |
| `rank`         | 关闭时为向量名次；开启时为重排名次，未参与者为 NULL |

跟随当前排序使用 `WHERE s.rank IS NOT NULL ORDER BY s.rank`。
旧 `ORDER BY s.score DESC` 与 `score` 阈值继续表示余弦语义，不随全局开关改变。
重排分数不能与余弦分数混排，也不表示概率；不同调用的名次没有全局可比性。
新增列会改变 `SELECT *` 的列集合，显式选择旧列的查询保留原含义。
向量同分按记录 ID 排序，重排同分保留候选顺序。

### 执行、预算与诊断

准备一个评分源时一次完成向量评分和重排，再供给 SQLite，重执行不重复发送相同输入。
同会话相同查询和有序候选文本共享完整评分；首版只做批内复用。失败、取消和迟到结果不缓存为成功。
最多调度 16 次不同重排请求，并发最多 2；每条文本使用连接字符上限，完整请求体最多 2 MiB。
服务必须返回全部候选的完整、唯一且合法的索引和有限分数；本地映射回原记录，最终 SQL 决定输出数量。

embedding、重排及 SQL 共用原有 10 秒总 deadline，不为新阶段重置预算。
空范围或没有有效候选不发远程请求；显式启用但未配置连接仍报错。
重排失败使所属查询失败，宏按现有规则输出为空，其他成功宏保留；停止、跳过和切对话取消全链路。
最近结果诊断记录候选数、文本字段、重排耗时与批次请求/复用数量。
首版仅重排单表记录；跨表合成文本和聚合结果本身不作为独立候选。
