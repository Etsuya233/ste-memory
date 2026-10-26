# 原生语义表值函数技术探针

2026-10-26，Node v24.18.0，仓库当前 `@sqlite.org/sqlite-wasm` 3.54.1-build1，真实 SQLite WASM。只注册临时 eponymous-only virtual table，使用内存假评分关系；没有网络请求，没有改生产代码。

结论：原生表值函数、缺源中断及外层重执行在本次探针中可行；`sqlite3_vtab_rhs_value` 加 `sqlite3_value_frombind` 不能可靠证明参数与外层行无关。尤其不能把 `frombind=1` 解释为 SQL 调用处直接使用了命名绑定。

## 参数可见信息

下表仅列第三个 query 参数。前两个参数固定为字符串字面量。

| 参数形态                             | xBestIndex RHS        | xFilter frombind | 本次观察                                   |
| ------------------------------------ | --------------------- | ---------------- | ------------------------------------------ |
| `'question'`                         | SQLITE_OK，值可见     | 0                | 字面量可在规划期识别                       |
| `:q`                                 | SQLITE_NOTFOUND（12） | 1                | 直接绑定保留标记                           |
| `?1`                                 | SQLITE_NOTFOUND       | 1                | 该标记不提供参数名称或参数编号             |
| 持久表 `o.q`                         | SQLITE_NOTFOUND       | 0                | 两行分别传入 first、second                 |
| 字符串拼接常量                       | SQLITE_NOTFOUND       | 0                | 常量表达式与持久表列具有相同的这组标记     |
| `CAST(:q AS TEXT)`                   | SQLITE_NOTFOUND       | 1                | CAST 后本例仍保留绑定标记                  |
| UNION CTE 的 `i.q`，行来源为两个绑定 | SQLITE_NOTFOUND       | 每行均为 1       | 随外层行变化，仍通过“字面量或绑定标记”检查 |

最后一项的完整反例：

```sql
WITH inputs(q) AS (SELECT :q UNION ALL SELECT :q2)
SELECT i.q, s.score
FROM inputs i
CROSS JOIN semantic_scores('facts', 'group', i.q) s;
```

绑定 `:q='bound-one'`、`:q2='bound-two'` 后，两次 xFilter 分别收到不同文本，第三参数 `sqlite3_value_frombind` 均返回 1。探针启用候选规则“规划期 RHS 可见，或运行期 frombind 非零”后，该反例成功返回结果。普通持久表列则被规则拒绝。因而该规则无法承担禁止所有 row-correlated 参数的承诺；拒绝 frombind 为零的全部参数还会拒绝本次字符串拼接常量。

探针排除了使用这组 API 证明参数独立性的方案，其他原生识别方案尚未验证。采用有界动态源时，应明确允许 SQLite 在不同外层行传入不同文本，并为其成本设置显式上限。

## Prepare-only 语义宏分类

另在同一真实 WASM 连接注册 authorizer，每条语句新建 READ 集合，只执行 prepare、必要的 bind、finalize，之后移除该次观察器。分类仅检查 `SQLITE_READ` 的表名是否为 `semantic_scores`，不要求列名非空，且不使用 xConnect 状态。每条观察前后断言 xFilter 计数未增加；没有执行 SQL，没有请求向量。

| SQL 形态                                                                       | READ semantic_scores | 分类               |
| ------------------------------------------------------------------------------ | -------------------- | ------------------ |
| 普通 `SELECT q FROM outer_inputs`                                              | 无                   | 普通               |
| 直接 `SELECT * FROM semantic_scores(...)`                                      | 三个可见列           | 语义               |
| `SELECT count(*) FROM semantic_scores(...)`                                    | 有，列名为空串       | 语义               |
| 使用该源的 CTE                                                                 | 有                   | 语义               |
| 使用该源的子查询                                                               | 有                   | 语义               |
| 该源加 `WHERE 0`                                                               | 有                   | 语义，允许保守停用 |
| `CASE WHEN :enabled THEN (SELECT count(*) FROM该源) ELSE 0 END`，分别绑定 0、1 | 两次均有，列名为空串 | 两次均为语义       |
| 定义该源但未引用的 CTE，主查询 `SELECT 1`                                      | 无                   | 普通               |
| xConnect 已发生后再准备普通 `SELECT 1`                                         | 无                   | 普通               |

第一次直接函数 prepare 触发 xConnect，后续普通 SELECT 仍正确分类为普通，因此 xConnect 应只初始化固定元数据。WHERE 0 和绑定控制分支的观测说明分类可覆盖这些当次可能不产生请求的已编译引用，无需为了分类 step SQL 或读取绑定后的分支结果。

未引用 CTE 的反例为：

```sql
WITH unused AS (
  SELECT * FROM semantic_scores('facts', 'group', 'question')
)
SELECT 1;
```

该次 prepare 没有 READ，也没有 xFilter，因此 prepare 本身不产生费用。按照“只在执行到 xFilter 的缺源请求时才准备向量”的架构，未执行的 CTE 不应产生请求；本轮按要求未 step 这些分类样例，未另外测量完整生成过程的请求次数。authorizer 不能把这种未编译的词法调用保守标记为语义宏；采用该分类方式时，“包含语义源”应表述为当前语句 prepare 授权阶段观察到语义源读取，不应声称穷尽 SQL 文本里的全部调用。如果之后编辑 SQL 使 CTE 被使用，需要按新表达式重新分类。

## 缺源、中断与重执行

xFilter 将缺失的三元组写入宿主 pending 集合，设置 `STE_SEMANTIC_SOURCE_PENDING` 错误文本并返回 `SQLITE_ABORT`。这里使用 SQLite 标准错误码 4 加专用文本和 pending 侧信道，没有验证自定义扩展错误码；生产判断不能只凭一般 SQLITE_ABORT 就发送外部请求。

第一次 step 报错后，在外层准备两行假评分数据，再调用 `resetNoThrow()`。reset 返回前一次的错误码 4，但已完成重置；随后的 step 正常返回。相同 SQL 完成 finalize、重新 prepare、重新绑定后也正常返回。两条路径都用 `ORDER BY score DESC LIMIT 1`，源的第二行分数最高，最终均选中第二行；探针没有把 LIMIT 约束交给源，也没有提前截断评分关系。

另一个查询先通过 UNION ALL 输出 `['prefix', 0]`，随后才访问缺失源并报错。准备数据后整体重跑，又返回该 prefix。外层必须丢弃本轮全部部分结果，只能在某次完整执行成功后发布最终行集，否则会重复或混合不同执行遍次的结果。

## 有界动态源路线的语义注意点

该路线允许上述 UNION CTE 逐行产生不同的源，缓存应以最终求值后的完整三元组区分。只读 SQL 仍可使用 `random()` 等非确定表达式，重执行时它们可能生成新的 query 文本、继续遇到新缺源；明确的三元组数、文本数、遍次、累计 SQL 时间与总时间上限可将其终止为错误，不能保证所有合法 SQL 最终成功。SQL 的短路和 LIMIT 也可能使某些调用从未执行，不能承诺预先发现所有语法上出现的源。

本探针没有实现这些计数与时间策略，没有验证 Agent 接入、生产 Worker 隔离、取消、连接快照或缓存失效。它只证明表值函数的底层回调信息与重执行行为。

## 复现

```powershell
node --experimental-strip-types .scratch/sql-semantic-functions/native-vtab-probe.ts
```

脚本对上述关键结果执行断言，并将完整 xBestIndex／xFilter／错误／重试记录输出为 JSON。预期拒绝和缺源错误会同时在 stderr 留下 SQLite 调试消息；所有断言通过时退出码为 0。实现仅引用当前仓库已安装的 SQLite WASM 包，评分使用本地固定数组。
