# 数据库优化建议报告（聚焦「平野健介1」空间）

> 分析日期：2026-08-06
> 分析对象：`data/ste-memory.sqlite`（复制到 worktree `feature/db-analysis` 的只读副本）
> 分析范围：**平野健介1 空间（`fdd98bb5`）为唯一真实实验数据**；其余三个空间（藤ノ森学園の放課後、藤ノ森学园放学后、冒烟测试）为 seed/冒烟数据，仅作对照，不在优化范围内。
> 迁移版本：0001–0006 全部应用，`integrity_check` = ok，`foreign_key_check` = 0 违规。

---

## 0. 现状快照（平野健介1）

| 项目 | 数量 | 备注 |
|---|---|---|
| 表 | 8 | 7 张系统表 + 1 张自定义表 `test`（2 字段，0 记录） |
| 字段 | 54 | 其中 **27 个（50%）prompt 为空** |
| 记忆记录 | 38 | characters 3 / foreshadowing 12 / items 2 / locations 6 / plots 6 / relationships 2 / todos 7 |
| 修订历史 | 180 行 / 39 个记录 | 最长修订链 25 个；**其中 5 个记录已删除，留下 11 行孤儿历史** |
| 证据 | 220 条（全部 reference 模式） | **没有任何记录引用它们**（`field_evidence_json` 全为空数组） |
| 源消息 | 1231 条（2026-02-24 ~ 05-04） | 220 processed / 1011 untracked，**仅覆盖对话前 3 天（~18%）** |
| 填表任务 | 8 个 | 2 failed + 3 succeeded + 1 cancelled + 1 interrupted + **1 残留 running** |
| 清洗规则 | 1 条 | `Cot` discard `<CoT>[\s\S]*?</CoT>` |

库总体积 22 MB，其中 `source_store_messages.extra_props_json` 占 **5.3 MB（约 1/4）**。

---

## 1. 高优先级问题

### 1.1 残留 `running` 填表任务阻塞该空间所有新任务

**数据证据**：`memory_fill_tasks` 中有一条 `running` 任务（run `9666b9a4`，范围 221–239，`created_at` 与 `updated_at` 相差 0.01s），创建后进程立即死亡，状态永远停在 `running`。此前一条 `interrupted`（同为 221–239）是 API 上次启动时被 `markInterruptedOnStartup()` 标记的。

**影响**：`memory_fill_tasks_active_space` 部分唯一索引（`WHERE status NOT IN (终态)`）保证每空间至多一个活动任务。残留 `running` 行**占着这个坑**：在 API 下次启动（才会把非终态任务统一标记 interrupted，见 `main.ts:164`）之前，平野健介1 无法启动任何新填表任务；如果数据库被复制/迁移到新环境而 API 未启动，该阻塞会一直存在。

**建议**：
- 任务执行器增加**心跳/存活时间戳**（如 `last_heartbeat_at`），启动清理时把「心跳过期」的 `running` 也标记为 `interrupted`，而不是只依赖进程正常退出。
- 或在唯一索引判定中排除「心跳过期的 running」。
- 当前数据的即时修复：手动将这条 `running` 置为 `interrupted`（或复制库后先启动一次 API）。

### 1.2 记录完全无法溯源：证据溯源机制实际未生效

**数据证据**：
- 38 条记录的 `source_json` **全部**为 `{"type":"source","sourceTime":null,"sourceLocation":null}` —— 没有任何记录指向具体消息；
- 220 条 `memory_evidence`（= 220 条 processed 消息，1:1 建立）**零引用**：全库 `field_evidence_json` 只有 6 行非 `{}`，且值全部是空数组 `[]`；
- 领域层（`submit-proposal-tool.ts`、`memory-record-service.ts` 的 `resolveFieldEvidence`）完整实现了证据解析，但真实流水从未传过证据。

**影响**：这是 ADR 0010/0011 设计的功能（字段级证据溯源、正确性评估、问题追踪）**在当前数据中完全失效**。38 条记录无法回溯到任何原始消息，无法验证 agent 填表是否正确；220 条 evidence 是纯死数据。

**建议**：
- 填表 agent 的提示词/工具契约中**强制要求** `submit-proposal` 携带 `evidence`（至少每条新记录/每个字段变更附上来源消息 id）。
- 兜底：若 agent 未附证据，服务端把 `sourceTime` 落为消息 `send_date`，保证最小溯源。
- 考虑在覆盖率视图（ticket 17 的 coverage）中增加「无证据记录」计数，让缺口可见。

### 1.3 孤儿修订历史：已删除记录的历史不可达

**数据证据**：`memory_record_history` 中 5 个 `record_id`（46ff5465 / 3d6c00e8 / f745023d / 02b8e9a7 / e8360359）在 `memory_records` 中已不存在，共 11 行死数据。删除记录时 history 行保留（这是设计：历史链不可变），但 `record_id` 无 FK、查询入口只有「按 record_id 查」，删除后这些行**永远无法被访问**。

**建议**：
- 方案 A（简单）：删除记录时同步删除其历史链（保留「空间级审计」由 fill task 日志承担）。
- 方案 B（保留可追溯性）：给 history 加 `deleted_at` 墓碑列 + 墓碑记录行（`record_id` + 最后修订），使「已删除记录」仍可被列出。
- 至少补一个启动/定期清理脚本把孤儿行清掉，避免无限累积（agent 高频删除场景下增长很快）。

---

## 2. 中优先级问题

### 2.1 消息处理覆盖率仅 18%，且取消/中断后无人接手

**数据证据**：任务时间线显示处理推进到消息 220（2026-02-26 的对话）后：`101–300` 任务跑了 30 分钟（11:25→11:55）只完成 120 条即被取消；`221–239` 中断后又启动一次即崩溃。**1011 条消息（2-26 至 5-04，两个多月对话）从未进入处理范围**。

**影响**：记忆只覆盖了对话前 3 天；实验数据代表性不足。

**建议**：
- 恢复任务继续处理 221–1231（先手动清理 1.1 的残留行）。
- 评估 30 分钟 120 条的速度瓶颈（agent 调用延迟 vs block 内消息数）：`block_size=10` 时每条消息一个往返，可尝试增大 block 或让单次 proposal 处理多消息。
- `cancelled` 语义确认：取消时已处理的消息标记是否回滚（当前 processed 精确到 220，与取消范围 101–300 吻合，说明取消是「处理到哪算哪」——确认这是预期行为并文档化）。

### 2.2 重复失败任务行，重试无幂等语义

**数据证据**：`1–31 block=5` 的任务失败两次（17:32、17:35），两次失败原因相同但产生两行独立记录；随后第三次（17:43）才成功。

**影响**：任务表没有「同一范围+同一 block 的失败去重」约束，重试会无限堆积重复行；也无法从数据上区分「首次失败」与「重试失败」。

**建议**：加部分唯一索引 `UNIQUE(memory_space_id, from_source_id, to_source_id, block_size) WHERE status = 'failed'`（或业务层幂等键）；保留失败历史用于审计是合理的，但需明确「失败后重试 = 新行」的语义。

### 2.3 `extra_props_json` 存储 5.3 MB 原始消息全文，占库 1/4

**数据证据**：平野健介1 的 1231 条消息，`extra_props_json` 平均 4.4 KB/条（总计 5.3 MB），远超 `content` 本身（3.8 MB 总计）。抽查显示其中包含 `name / is_user / is_system / send_date / extra{...}` —— `extra` 是 ST 消息的原始扩展块。

**影响**：单空间 1231 条消息就占 1/4 库体积；长对话（本实验的目标场景是数万条消息）会线性膨胀到数百 MB。当前 schema 无法针对 JSON 子字段建索引/压缩。

**建议**：
- 导入时只保留**规范化字段**（`name / is_user / is_system / send_date / lineNumber`），原始 `extra` 块默认丢弃或按配置保留（与 cleaning_rules 类似的导入选项）。
- 若需保留原始块：单独一张 `message_extra` 表（懒加载）或 gzip 压缩存储。

### 2.4 一半字段没有 prompt，agent 填表无字段级指导

**数据证据**：平野健介1 的 54 个字段中 27 个 `prompt = ''`，分布在每张表（characters 5、foreshadowing 4、items 4、locations 4、plots 2、relationships 2、todos 4、test 2）。

**影响**：`prompt` 是 agent 填表时的字段指导文本（表级 prompt 只描述整张表）。50% 字段缺指导，long_text 类字段（全局 93 个中 69 个空）尤其依赖它。当前填写率数据（name 36/36、details 31/31）尚可，但无法区分「表级 prompt 足够」还是「agent 自行发挥」。

**建议**：确认设计意图 —— 若字段级 prompt 允许为空（继承表级），在模板和文档中明确；若应有值，补全模板并写一次性回填迁移（只影响新空间，旧空间不受模板变更影响）。

### 2.5 系统表模板漂移：同一张「系统表」三套定义并存

**数据证据**（跨空间对照）：`plots` 表的 `start_time/end_time` 字段——
- 冒烟测试 & 藤ノ森空间（08-04 种子）：类型 `date`
- 平野健介1（08-05）：类型 `datetime`，且多一个 `special` 字段
- 当前 API 模板（已收编至 `@ste-memory/memory-host-shared`，见 `packages/memory-host-shared/src/system-memory-table-definitions.ts`）：`datetime`、无 `special`

**影响**：系统表定义至少演进过 3 个版本，但 ADR 0003「空间拥有表定义」意味着旧空间**永久保留旧快照**，没有对齐/升级机制。随着模板继续演进，各空间系统表会越来越不一致，跨空间对比实验（本项目的核心目的之一）失真。

**建议**：
- 给系统表模板加**版本号**（`memory_tables.template_version`），`kind='system'` 的表记录来源模板版本。
- 提供「系统表升级」用例：把旧版本系统表按新模板迁移（新增字段、字段类型转换），用户显式触发。
- 迁移 0003 的快照注释已说明与模板「同时点保持一致」——把该约束变成可执行检查（seed 后断言模板一致性）。

---

## 3. 低优先级 / Schema 层优化

| # | 问题 | 现状证据 | 建议 |
|---|---|---|---|
| 3.1 | `memory_tables.display_strategy` 无 `json_valid` CHECK | 其他 JSON 列都有 CHECK，唯独它没有；`fieldId` 也无 FK（当前数据恰好一致） | 补 CHECK + FK（指向 `memory_fields.id`），并在 DB 层约束 fieldId 属于本表（或至少同空间） |
| 3.2 | `memory_evidence` 无时间戳、无 FK 到消息表 | 220 条 evidence 与 220 条 processed 消息 1:1，纯靠约定 | 加 `created_at`（已有 `updated_at` 语义时对齐其他表）；加 `source_id_json` 与消息表的对应约束（弱 FK，因 source 类型可扩展） |
| 3.3 | 冗余 `memory_space_id` 无复合 FK 保护 | `memory_fields/records/history` 同时存 `memory_space_id + table_id`，但 FK 是分开的两条，数据库无法保证「table_id 与 memory_space_id 同空间」（当前数据 0 违规） | 加复合 FK `FOREIGN KEY (table_id, memory_space_id) REFERENCES memory_tables(id, memory_space_id)`（需在 memory_tables 上加 UNIQUE(id, memory_space_id)），把不变量下沉到 DB 层 |
| 3.4 | 修订历史全量快照存储 | 最长链 25 个修订 × 每次全量 payload（当前 ~500B/条，尚可） | agent 高频修订场景下历史体积增长快；可评估 diff 存储（仅存字段级增量），**当前规模不建议做** |
| 3.5 | 删除被引用记录 = JSON 全扫描 | ADR 0006 的引用完整性检查需扫描 `payload_json` 里的 reference 字段值（当前 38 条记录、93 个引用，瞬时完成） | 规模增长后（数千记录）成为热点：物化 `memory_record_references(record_id, field_id, target_record_id)` 引用表，删除检查走索引 |
| 3.6 | `journal_mode=delete` | 填表任务后台写 + Web 读并发（better-sqlite3 单连接，同进程） | 单连接场景收益有限，**保持现状可接受**；若未来拆分进程再评估 WAL |
| 3.7 | 索引覆盖 | 逐条核对 repository 查询：全部命中现有索引或 PK 前缀，**无缺失索引** | `memory_tables_space_id(memory_space_id, id)` 与 PK 部分重叠，但服务于空间级级联删除，保留合理 |
| 3.8 | UUID 主键随机写入 | 无具体故障 | 页分裂导致的写入开销在万级记录后可观察；届时可评估 `INTEGER` 自增代理键 + UUID 业务键（当前规模不做） |

---

## 4. ST 接入与 Agent 上下文长度视角：系统表该如何优化

> 本节从「每次填表调用的上下文（token）成本」出发，基于代码确认的上下文构成 + 平野健介1 的实际数据量化。

### 4.1 Agent 调用时的上下文构成（代码确认）

每次处理一个消息块，Agent 会话的上下文由四部分组成：

| 组成 | 内容 | 成本类型 |
|---|---|---|
| 系统提示 | 固定指令 + **全部启用表/字段摘要 digest**（`composeProposalAgentSystemPrompt`，每字段仅 key/name/type/required/options/referenceTableKey，**不含字段 prompt**） | 固定，每次调用全量 |
| 消息块 | `composeBlockPrompt`：清洗后的消息（CoT 已被 `applyCleaningRules` 剥除） | 随 block 大小线性 |
| 工具往返 | `query_records`（默认 20 条/页、**全字段返回**）→ `mutate` → `proposal_preview` 整批 diff 回显 | 动态，最大头 |
| 修订历史 | **不进上下文**（历史只落库） | — |

### 4.2 量化：token 花在哪（平野健介1 实测）

- **digest 固定成本：2077 字符 ≈ 1.2K tokens/次调用**（8 张表、54 字段）。7 张系统表之外，自定义 `test` 表也占 65 字符。
- **query_records 一次查询：最重 20 条记录 = 21.7K 字符 ≈ 12.8K tokens** —— 是 digest 的 **10 倍**。全部 38 条 = 30.1K 字符。
- **77% 的 payload 字符来自长文本字段**（personality / details / key_facts / current_status / background 等）：personality 单条最长 1634 字符。
- **每块会话典型成本 ≈ 15–40K tokens**，其中记录长文本是绝对大头。
- **~65% 的块是纯开销**：110 个回合（220 条消息）只产出 38 条记录，即约 2/3 的块最终是「全流程跑一遍后确认无变更」，系统提示 + 工具往返全部浪费。
- 当前实测速度：220 条 / ~67 分钟 ≈ 3.3 条/分钟（含失败重试；块=5 时每次 Agent 会话约 70–80 秒）。

### 4.3 系统表定义层（digest 固定成本）

1. **删掉/禁用从未填写的字段，它们是纯 digest 税**：平野健介1 的 `plots.start_time / end_time / special`、`todos.due_date`、自定义 `test` 表（`哈哈？？？`）——agent 处理 220 条消息从未提交过这些字段，但每次调用它们的定义行都在。模板漂移（2.5）修复时一并审计：**模板字段 = digest 行数，每个字段都有持续的 token 成本**。
2. **表级按需启用（分阶段模板）**：7 张系统表全启用对早期对话（3 天/220 条）过重。建议按空间消息量分阶段：早期只启用 `characters / locations / plots`（摘要约 900 字符，比全量 2077 省 55%），`foreshadowing / relationships / items / todos` 在消息量/记录数达到阈值后自动启用。`enabled` 字段与 digest 过滤已就绪，缺的只是模板策略。
3. **字段摘要行本身已精简**（key+中文名+type，无 prompt 无 id），无需再压；真正的优化在 4.4 的记录呈现。

### 4.4 记录呈现层（动态成本，最大头）

1. **长文本字段截断视图（最高收益单项）**：`query_records` 返回时对 `long_text` 默认截断（如 200 字符 + 省略标记），需要全文时用显式参数或单独查询。当前 personality 等 3 条角色记录 ≈ 3K tokens/次查询，截断后 ≈ 1/10。建议在字段定义加 `context_limit` 元数据（模板级，可按字段配置），或按 type 内置默认（long_text=200）。**不必拆字段**（拆成「摘要+详情」会增加 digest 行数，两害取其轻，截断更优）。
2. **引用字段返回 display 名（查询契约 v2）**：当前引用字段返回**裸 UUID**（`query-records-tool.ts` 注释明示 v1 裸 id），模型每次都要再查目标表才能理解引用含义 → 每个引用引发 1–2 次额外工具往返（每往返 3–13K tokens）。改为返回 `{id, display}` 或直接 display 名数组，省掉连锁查询。
3. **默认 pageSize 20 → 10**：模型绝大多数查询只需要几条相关记录；配合排序让「最新/最相关」在前。
4. **查询结果按 updated_at 倒序**（或按条件命中度排序），减少模型翻页。

### 4.5 消息与块策略（ST 侧）

1. **块大小 5 → 10–20**：digest 1.2K + 工具往返是固定成本，块放大 4 倍可摊薄 4 倍（理论 220 条/67 分钟 → 1000+ 条/小时）。风险是单轮上下文增大与质量波动，建议 10–15 起步实测。
2. **空提案块跳过（最大单项时间节省）**：~65% 的块无变更却完整跑一遍 Agent。加变更信号预筛：消息内容命中角色/地点/任务关键词（或 embedding 相似度）才启动 Agent，无信号块直接 `markProcessed`。可把低信号消息并入相邻块兜底，避免漏记。
3. **清洗规则补充（输入 token 减半）**：ST 的 SYS 回复正文常以**复述用户台词**开头（如 `#221` 引号开头整段复述 `#220`），当前只有 `Cot` 一条规则。增加「引用行去重」规则（`^["“『].{0,100}["”』]` 开头的整段复述行丢弃）、空消息/纯表情过滤，可再省 10–20% 输入。

### 4.6 端到端提升估算（ST 典型长对话）

假设 ST 对话 5000 条消息（2500 回合，与当前数据形态一致）：

| 方案 | 处理时间估算 | 单会话 token 估算 | 说明 |
|---|---|---|---|
| 现状（块=5，无跳过） | ~25 小时 | 15–40K | 3.3 条/分钟 |
| +块=15 +空块跳过 +记录截断 +引用 display | **2.5–4 小时** | 6–12K | 约 **6–10 倍**提速、token 降 3–5 倍 |

优化后单会话峰值 ≈ digest 1.2K + 消息 6–12K + 记录截断 3–6K ≈ 12–20K tokens，远低于主流模型窗口（64K+），上下文安全余量大。真正的天花板从「上下文长度」转移到「LLM 调用延迟 × 有变更块数」，这也是空块跳过收益最大的原因。

> 顺带修正：字段 `prompt` **不进 digest**（仅作填写指导），因此 2.4 的「空 prompt」只影响填写质量、不占上下文 token；从上下文角度它无害，从质量角度仍需补全。

---

## 5. 长文本字段失控：系统表字段设计优化（重点）

> 用户关注的焦点：角色表「秋元悦也」性格特征已 2000+ 字，即使接入总结也嫌长。分析结论：**不是 prompt 写得不够好，而是约束从未生效**（见 5.2 证据链）。

### 5.1 失控事实（数据证据）

**增长轨迹**（平野健介 personality，25 次修订，零压缩）：

```
76 → 125 → 205 → 329 → 409 → 524 → 881 → 1040 → 1153 → 1416 → 1532 → 1634
每次修订 +49 ~ +357 字符，25 次修订中无一次下降
```

**全部 long_text 超 300 字**（不是个例）：

| 字段 | 超限值 |
|---|---|
| characters.personality | 1634、929 |
| characters.current_status | 350、314 |
| characters.notes | 875、663 |
| relationships.key_facts | 1220、478 |
| foreshadowing/plots.details | 503、636、628、1725 |

**内容形态错误**：`current_status` 的 prompt 明确写着「描述此刻仍成立的状态，不写逐条事件流水」，实际内容是「客厅看电视进行中：悦也回『没你搞的疼』并开电视后，软声直呼其名……（第一次日常清醒场合被叫名字，心脏狂跳）……」—— 典型的**逐条事件流水**。personality 里也混入一次性场景转写（「被悦也假摔诡计骗得受惊、条件反射死死抱住他腰，揭发后恼羞成怒大喊要把他扔进海里」），而非稳定特质摘要。

### 5.2 根因：约束从未生效（三层证据）

1. **约束载体缺失**：字段 prompt（唯一写着「不得超过300字」的地方）**不进 Agent 上下文**——digest 只含 key/name/type/required/options/referenceTableKey（`digest.ts`），`composeProposalAgentSystemPrompt` 里 Agent 看到的只有表 description + 字段行。**「不得超过300字」Agent 从未见过**。
2. **校验层缺位**：`validateMemoryFieldValue`（`memory-record-validation.ts`）只验类型（string/number/array），**无任何长度校验**；`long_text` 与 `short_text` 在运行时无本质区别。提案超长照样 valid。
3. **无压缩触发点**：update 是全量重写，没有任何机制要求/迫使 Agent 合并旧内容；25 次修订 0 次下降即证明。

结论：字段 prompt 是**给模板作者/人看的文档**，不是 Agent 的约束。约束必须落在「Agent 可见的上下文」和「硬校验」两层，缺一即失效。

### 5.3 系统表优化方案（按可靠性排序）

1. **字段元数据 `max_chars`（迁移 0007）**：`memory_fields` 加 `max_chars` 列，模板为每个 long_text 字段定义上限：personality/appearance/current_status 300、background/role 200、details/notes/key_facts 500（数值按实验调）。有界化是唯一能防「随对话长度无限膨胀」的手段。
2. **校验层硬约束（最可靠）**：`validateMemoryFieldValue` 对超限值报错，错误消息带「字段名 + 上限 + 当前长度」，复用现有错误回喂自愈机制（`submit_proposal` 报错 → Agent 收到错误 → 压缩后重提）。Agent 想提交必须压缩——这是**唯一能保证字段值有界**的机制，也是压缩行为的触发点。
3. **digest 渲染约束（Agent 可见）**：digest 字段行对 long_text 加「≤300字」后缀（54 字段中 23 个 long_text ≈ +230 字符 ≈ 135 tokens/次调用）。让 Agent 动手前就看到上限，减少「写了再被拒」的往返。与 2 配合：先见、后验。
4. **prompt 分层重写（模板层）**：区分三类 long_text 的语义与写作要求——
   - 稳定特质（personality/appearance/background/role）：「只写稳定不变的显著特质，合并同类项；不记录一次性事件；每次更新时压缩旧内容，总长 ≤ N 字」；
   - 状态（current_status）：「只保留当前仍成立的状态；新状态覆盖旧状态时删除旧内容」；
   - 详情（details/notes/key_facts）：「事件摘要，非全文转写；≤ N 字」。
5. **字段语义边界**：personality 里的一次性场景应提炼为特质（「占有欲强、易吃醋」），具体事件进 current_status/details。模板字段职责说明里写明「本字段放什么、不放什么」，避免 agent 把事件流水和稳定特质混写。
6. （可选激进）结构化特质：personality 改 `short_text_list`（每条一个特质，天然有界、可增删）——改动大、与现有类型体系冲突，`max_chars` 优先。

### 5.4 收益估算

- personality 1634→300：角色查询上下文 ~3000→~600 tokens（3 角色）。
- 全部 long_text 有界后：`query_records` 单次查询 12.8K→~4–5K tokens（**-60%**）。
- 防增长：5000 条消息的 ST 对话若不禁，personality 可能膨胀到 2 万+字直接把上下文打爆；`max_chars` 从**写入端**治本，4.4 的截断视图从**读取端**兜底，两者互补。

---

## 6. 全量内容质量审查（38 条记录逐字段阅读）

> 方法：导出全部记录（字段名替换 UUID、引用解析为名字），逐表逐字段阅读。结论：**引用类字段质量优秀；所有 long_text 字段系统性沦陷为「事件流水转写」；同一事件跨表重复记录高达 5 处**。

### 6.1 逐表审查结论

**characters（3 条）**
| 字段 | 质量 | 问题 |
|---|---|---|
| name / aliases | ✓ | 正确简洁（阿长别名齐全） |
| role | ✓ | 一句话身份，准确 |
| personality | ✗ 越界 | 1634/929 字；前 1/4 是稳定特质（嘴硬心软、占有欲强、爱撒娇），后 3/4 全是**一次性事件转写**（「被悦也假摔诡计骗得受惊……大喊要把他扔进海里」）与情事细节 |
| appearance | △ | 秋元悦也 131 字里混入「今晨穿白色衬衫」「午饭后新配眼镜」——**当日穿着/事件性变化不是外貌** |
| background | △ | 只有 12–62 字，且内容与 role/current_status 重叠（「一起放学回宿舍」是状态不是背景） |
| current_status | ✗ 违反自身 prompt | prompt 写「不写逐条事件流水」，实际 3 条全是流水（「客厅看电视进行中：悦也回『没你搞的疼』并开电视后……」） |
| notes | ✗ 垃圾桶 | 875/663 字事件流水+情事细节（「明言『今天没带套』，未经扩张直接结合……」）；notes 是**无 prompt 字段 = agent 倾倒场** |

**relationships（2 条）**：description 133 字质量好（稳定关系认知）；current_status 又是流水；key_facts 1220 字**完全越界**（90% 是逐条事件+情事全程，真正关键事实只有「已同居/已发生关系/昵称约定」）；notes 与 key_facts **重复记录同一堆流水**。字段职责重叠（description/key_facts/notes 三字段都在被塞流水）。

**locations（6 条）**：name/type 清晰；details 有实质内容但混入事件（「把钥匙忘在玄关鞋柜」）；current_status 全部是事件流水；related 引用正确。

**items（2 条）**：owner/current_location 引用正确；套套的 current_status 写成**使用历史**而非物品状态（有效信息只有最后一句「盒子仍留在宿舍，未被使用」）——long_text 状态字段应改为枚举；眼镜 name 带括号解释（「银灰色半框眼镜（悦也的新眼镜）」）本应在 notes。

**plots（6 条）**：name 写成 20+ 字事件标题（short_text 被扭曲）；details 最长 1725 字——**事件全文转写**，且其 prompt「不得直接丢弃原有内容，应在此基础上总结或续写」是**主动鼓励只增不减的毒药**；4425f428 一条 plot 装了情事+浴室+客厅三个场景（事件粒度过大）；special / start_time / end_time **全部 6 条未填**（事件时间线明确：今晨/午饭后/晚上——agent 不填 datetime 是因为 ST 消息里只有相对时间，没有绝对时间！）；status 用得正确。

**foreshadowing（12 条）**：12 条对 3 天对话太多，至少 3–4 条是**凑数**（「天气预报短信」「套套盒子」）；「悦也的吃醋反应」与「健介的告白式耳语」是同一事件拆成两条；details 又是事件转写（线索本身应该只有一句话）；status/resolution_plan 质量好。

**todos（7 条）**：priority/status 正确；details 全是事件经过（「原为昨晚的晚餐计划，因昨夜二人亲密结合而搁置……」——todo 详情应该写「要做什么」不是「事情怎么发生的」）；**与 plots 重复记录同一事件**（取车=plots 33a5ddfe + todos 6894fea8 + foreshadowing 45cb33c3 三处；吃醋惩罚=plots + todos + foreshadowing 三处）。

### 6.2 六大系统性质量问题

1. **事件流水瘟疫**：除 name/引用/枚举字段外，几乎每个 long_text 都被写成事件转写；`current_status` 的「不写流水」prompt 在 3 张表同时被违反——agent 默认行为是「详细转写」，字段语义约束在运行时不存在（prompt 不进上下文 + 无校验）。
2. **同一事件跨表重复、无互链**：客厅看电视事件出现在 **5 处**（characters×2、relationships、locations、plots）；取车 3 处、吃醋 3 处。无「事件归位」规则。
3. **notes 是垃圾桶**：无 prompt 的字段 = 无处安放细节的倾倒场（875 字）。
4. **plots.details 的 prompt 主动鼓励增长**（「不得丢弃原有内容」）。
5. **字段语义重叠**：role vs background vs current_status、key_facts vs notes vs details——agent 分不清就往一处塞。
6. **字段存在但 Agent 不用**：special/start_time/end_time/due_date 全部未填——要么语义不清（special），要么格式与证据不匹配（ST 只有相对时间「今晨/午饭后」，没有绝对时间可填 datetime/date）。

---

## 7. 最佳系统表设计（v2 提案）

设计原则：**① 每字段只回答一个问题，语义正交；② 事件只归位一处（plots），其他表只写各自视角的稳定状态，跨表用引用链而非复制文本；③ 全字段有界（max_chars）；④ 约束 Agent 可见（digest/校验回喂）；⑤ 字段少而精，删垃圾桶字段；⑥ 时间用相对时间（ST 证据形态）**。

### characters（人物）
| 字段 | 类型 | 上限 | prompt（要点） |
|---|---|---|---|
| name | short_text 必填 | 30 | — |
| aliases | short_text_list | — | — |
| role | **short_text** | 50 | 一句话身份（学长/学生/发小） |
| personality | long_text | **300** | 只写稳定显著的个性特质，每条一句，合并同类项；**不记录具体事件、台词、场景**；每次更新压缩旧内容 |
| appearance | long_text | 300 | 只写长期不变的外貌；**不写当日穿着、临时配饰、事件性变化**（进 current_status） |
| background | long_text | 300 | 只写相识前/长期经历事实；与 role、current_status 不重叠 |
| current_status | long_text | 200 | 此刻仍成立的**状态句**（最多 3 条）；新状态覆盖旧状态；禁止事件叙述 |
| ~~notes~~ | **删除** | — | 垃圾桶字段，证据：875 字流水 |

### relationships（人际关系）
| 字段 | 类型 | 上限 | prompt |
|---|---|---|---|
| character_a/b | single_reference 必填 | — | — |
| summary | long_text（description 改名） | 200 | 关系的稳定定性（称呼、相处模式、地位） |
| current_status | long_text | 200 | 同 characters 约束 |
| key_facts | long_text | 300 | 关系里程碑与长期事实（已同居、已发生关系、昵称约定）；**非事件流水** |
| ~~notes~~ | 删除 | — | 与 key_facts 重复（证据：两者同一堆流水） |

### locations（地点）
| 字段 | 类型 | 上限 | prompt |
|---|---|---|---|
| name / type | short_text | 30 | — |
| details | long_text | 200 | 地点的**固定描述**（布局、氛围）；不含事件 |
| current_status | long_text | 200 | 此刻正在发生什么（「二人正在客厅看电视」）；事件结束后清空 |
| related_characters / related_items | reference | — | — |
| ~~notes~~ | 删除 | — | — |

### items（物品）
| 字段 | 类型 | 上限 | prompt |
|---|---|---|---|
| name / type | short_text | 30 | — |
| owner / current_location | reference | — | — |
| status | **single_select**（可用/已消耗/已丢失/已赠出） | — | 替代 long_text 状态（套套案例：状态是「未使用」，不是使用历史流水） |
| key_attributes | long_text | 200 | 固定属性 |
| ~~notes~~ | 删除或严格限定 | — | — |

### plots（剧情）—— 事件唯一归位处
| 字段 | 类型 | 上限 | prompt |
|---|---|---|---|
| name | short_text | 30 | 简洁事件名（不写括号解释） |
| details | long_text | **400** | **当前进度摘要；每次更新用新内容替换旧内容（覆盖式），禁止全文转写；删除「不得丢弃原有内容」** |
| related_characters / related_locations | reference | — | — |
| status | single_select | — | — |
| ~~special~~ | **删除** | — | 从未填过（证据：6/6 空） |
| start_time / end_time | **改为 time_hint: short_text** | 30 | 「今晨/午饭后/晚上」相对时间（证据：ST 消息无绝对时间，datetime 从未填） |
| ~~notes~~ | 删除 | — | — |

### foreshadowing（伏笔）
| 字段 | 类型 | 上限 | prompt |
|---|---|---|---|
| name | short_text | 30 | — |
| setup（details 改名） | long_text | 200 | 线索本身（什么还没闭环）一句话；不含事件经过 |
| related / status | — | — | — |
| resolution_plan | long_text | 200 | （现状已好，保留） |
| ~~notes~~ | 删除 | — | — |

### todos（待办）
| 字段 | 类型 | 上限 | prompt |
|---|---|---|---|
| name | short_text | 30 | — |
| details | long_text | 150 | 要做什么（谁、做什么）；**不写背景经过**；已完成/已放弃时清空 |
| related / priority / status | — | — | — |
| due_date | 改为 **relative_due: short_text** | 30 | 「今晚/周末」；与 plots 同因（无绝对日期） |
| ~~notes~~ | 删除 | — | — |

### 全局规则（模板层）
1. **事件归位**：事件本体只进 plots；characters/relationships/locations/items 只写各自视角的稳定状态；跨表关联用 reference 链，**禁止复制事件文本**（消除 5 处重复）。
2. **所有 long_text 有 max_chars + 校验层硬约束**（第 5 章方案，否则本设计依旧失效）。
3. **每字段 prompt 固定句式**：「本字段只记录……不记录……」+ 上限声明（≤N 字）。
4. **每表 5–7 字段**，无 notes 垃圾桶；「删字段」靠禁用（enabled=0）而非硬删，保留数据兼容。
5. 表数量回归 7 张（删 test 表）；仍按第 4 章分阶段启用。

### 预期收益（基于现数据重算）
- 全部记录有界后：payload 总量 30.1K→~8K 字符（-73%）；query_records 单次 12.8K→~3.5K tokens。
- 事件去重后：同一事件从 5 处记录降到 1 处，写入量约 -40%，上下文噪声同步下降。
- Agent 填写负担：字段数 54→~40，每个字段职责清晰后「乱塞」行为消失，修订质量与压缩行为可预期。

---

## 8. v2 实验验证（本 worktree 实测：同源 1–100 条消息）

> 实验环境：`data/v2-experiment.sqlite`（迁移 0001–0007）+ v2 模板 + DeepSeek `deepseek-v4-flash`，blockSize=10，Cot 清洗规则同旧版。任务一次成功（旧版同段曾失败两次）。

### 8.1 核心结果对比（同一段 1–100 消息）

| 指标 | 旧版 | v2 | 结论 |
|---|---|---|---|
| 任务结果 | 2 次 failed 后成功 | **1 次 succeeded** | 模板越清晰 agent 越少犯错 |
| 记录数 | 19 条（首日段） | 18 条 | 数量相当，无过度建记 |
| payload 总字符 | ~15K（19 条） | **8655（18 条）** | 体积约 -45% |
| personality 最长值 | 1634 字 | **160 字** | 全部 ≤ 上限 |
| 修订 diff 压缩率 | **0%**（纯追加） | **39%**（有增有减） | **agent 行为改变的最强证据** |
| 引用悬空 | 0 | 0 | ✓ |
| max_chars 超限 | — | 0（无一次触碰校验） | digest「≤N字」前置提示已足够，校验层作为兜底未触发 |
| 事件跨表重复 | 客厅事件 5 处 | **无重复**（只进 plots） | 事件归位规则生效 |
| 空字段 | special/start/end_time 全空 | **time_hint 全部填写** | 相对时间字段设计正确 |
| 伏笔数 | 12 条（含凑数） | **2 条** | 不再立琐碎伏笔 |
| 记录名 | 20+ 字带括号标题 | 5–8 字 | name 约束生效 |
| 情事流水（notes/key_facts） | 875/1220 字 | 无（字段已删） | 垃圾桶字段移除 |

### 8.2 v2 数据抽样（内容形态）

- **personality**（秋元悦也 120 字）：「天真烂漫、直率，会理直气壮地撒娇提要求；……喜欢主动撩拨。」——稳定特质为主，仍混有零星事件（「偷偷往购物车放套套」）但可控。
- **plots.details**（161–191 字）：「放学路上健介答应为悦也做汉堡肉配奶油浓汤，两人到超市采购……做饭之约圆满达成。」——覆盖式摘要，无全文转写。
- **foreshadowing.setup**：「悦也偷偷往购物车放了一盒套套并称『饭后甜点』……暗示今晚有超出做饭的安排。」——一句话线索 + 清晰回收信息。
- **items.status**：「可用」（枚举）；key_attributes 仍混入使用历史（见 8.3-2）。

### 8.3 残余问题（v2 仍需迭代）

1. **current_status 仍是事件叙述**（虽然短且有界）：「载着健介骑出海滩去上学，假装自行车不稳骗学长抱紧自己，得意揭晓『我装的』」——prompt 写「禁止事件叙述」但 agent 依然写成过程。需要**示例级引导**（字段描述给一个状态句范例）或接受该语义（当前状态 = 最近场景的简版）。
2. **items.key_attributes 写入使用历史**（prompt 禁止仍发生）——字段名「关键属性」语义模糊，建议改名「规格外观」并给示例。
3. **relationships display 有 2 条渲染为「平野健介 <-> 」**（同批 create 时引用目标尚未落库，display 计算时机问题，数据本身引用有效）。
4. **todos 已完成项未清空 details**（prompt 要求清空未执行）；「上学不迟到」属 agent 自行推断的凑数 todo。
5. max_chars 校验层全程未触发——作为兜底保留即可，但建议补一条测试验证超限拒绝路径确实工作。

### 8.4 结论

v2 方案（有界字段 + digest 可见上限 + 覆盖式 prompt + 事件归位 + 相对时间）在真实数据上验证有效：**体积 -45%、压缩行为从 0% 到 39%、事件重复消除、空字段消失、任务失败消失**。残余问题集中在「字段语义需要示例级引导」（current_status / key_attributes），属于模板迭代而非架构问题。

---

## 9. v3 实验验证（追加式 details + 稳定时间坐标）

> 实验环境：同一 `data/v2-experiment.sqlite` 库内新建空间 `30d75cc9`（「v3实验-平野健介」，v3 模板），API 以 v3 代码重启后创建；同源 1–100 条消息，blockSize=10，任务一次 succeeded。v2 实验空间 `189ba7c2` 未动。

### 9.1 v3 相对 v2 的模板改动

1. **plots.details 改追加式摘要**：保留已有事实 + 追加新进展，允许润色措辞但不得删除事实（details 是未来 RAG/搜索的语料，覆盖式 = 有损压缩逐轮衰减）；`maxChars` 400→800，digest「≤800字」提示同步；
2. **time_hint 改稳定相对坐标**：「第 N 天·时段」（第一天清晨/第二天傍晚）——RAG 检索无法对齐「今天/昨天」类相对锚点；
3. **时间推进 Agent 自洽**（v3 修正：宿主不再注入锚点）：规则写进字段 prompt——消息有明确时间表述（『第二天早上』）时按表述填写；无明确表述但剧情延续时沿用已有记录的天数；尚无任何时间记录且需要填写时从「第一天」开始；无信息则留空。

### 9.2 核心结果对比（同口径 1–100 消息）

| 指标 | v2 | v3 | 结论 |
|---|---|---|---|
| 任务结果 | 1 次 succeeded | 1 次 succeeded | ✓ |
| 记录数 | 18 | 15 | 更聚合（plots 2→1、todos 3→1） |
| payload 总字符 | 3158 | **2625** | -17% |
| personality 最长 | 120/160 | 89 字 | ✓ |
| plots.details 修订链 | 覆盖式摘要 | **9 版累积** [67,168,360,315,460,508,487,365,424]→316 | 追加式生效（见 9.3） |
| 事件跨表重复 | 无 | 无 | ✓ |
| 悬空引用 | 0 | 0 | ✓ |
| time_hint 填写 | 2/2（相对时间） | 1/1 但**未按格式** | ✗ 见 9.4 |

### 9.3 details 追加式验证（核心目标）

「放学后的汉堡肉之约」9 版修订链：长度 [67, 168, 360, 315, 460, 508, 487, 365, 424] → 当前 316 字。逐版抽查（前 30 字锚点保留检查）：**7/10 版本✓保留、3 版△改写且事实未丢**（如 v4 压缩句式「放学后健介靠悦也撒娇」替代「借疲惫靠在悦也身上撒娇」，超市/安全套/收银台/花椒事实全部延续；末版 424→316 为润色压缩，事件序列「超市→回宿舍→结合→泡澡同眠→次日清晨早餐→海边→到校」完整保留）。从未触碰 800 上限，校验层未触发——追加式语义 + 有界化同时成立。

### 9.4 残余问题：time_hint 未按格式（跨天事件死角）

唯一 plot 的 time_hint 填了「放学后傍晚至次日清晨到校（学校车棚）」——**未用「第 N 天·时段」、未标天数**。

根因分析：
- 追加式 details 鼓励 Agent 把事件并入同一 plot → 100 条消息的全部事件（放学后→次日清晨）收敛为 1 条跨天 plot；
- 单个「第 N 天·时段」坐标无法表达跨天事件，Agent 转而写范围描述；
- v2（覆盖式）同段拆成 2 条 plot（做饭之约 / 海边散步），天然避开跨天。

候选修复（未定，需与用户确认）：
- **A. 事件粒度规则**：跨入新的一天时收尾旧 plot、新开 plot（time_hint 永远单点坐标）；
- **B. time_hint 语义改为「事件开始时间坐标」**：跨天信息只进 details；
- **C. 状态表方案（用户提议）**：新增 story_state 表持续记录当前剧情时间/天气/节日/进行中事件，plot.time_hint 只填开始坐标，世界状态有唯一归位处。

### 9.5 内容质量抽查（v3 空间）

- characters.personality：稳定特质（54–89 字），无事件流水 ✓；current_status 仍偏场景叙述但短且有界；
- relationships：3 条（健介-悦也 / 阿长-悦也 / 健介-阿长），summary/key_facts 为稳定事实 ✓；
- locations：4 条，current_status 出现「已离开/采购已结束」清理行为 ✓；
- foreshadowing：2 条，setup 一句话线索 + resolution_plan 回收 ✓；
- **items.key_attributes 仍混入使用历史**（73 字：偷放/收银台/未被使用）——v2 残余问题 8.3-2 未解决；
- **todos.details 完成未清空**（写「汉堡肉早餐已完成上桌……正在用餐」）——v2 残余问题 8.3-4 未解决；
- 引用解析正常（owner→秋元悦也、current_location→宿舍），0 悬空。

### 9.6 结论

追加式 details 验证通过：**事实累积不丢、有界（≤800）、润色压缩主动发生**。时间坐标的格式死角暴露在「跨天事件」上——需在 A/B/C 中选一修复并重跑验证；key_attributes / todos 两条 v2 残余问题顺带处理（示例级引导）。

---

## 10. v4 实验验证（世界状态表 + 字段格式校验）

> 实验环境：同一 `data/v2-experiment.sqlite` 库内新建空间 `c42a467f`（「v4实验-平野健介」，v4 模板，迁移 0001–0008），同源 1–100 条消息，blockSize=10，任务一次 succeeded。v2/v3 实验空间未动。

### 10.1 v4 相对 v3 的改动

1. **新增 story_state 世界状态表**（剧情时钟唯一载体，全表单条覆盖式记录）：`current_time`（第 N 天·时段）/ `current_location`（当前地点）/ `weather` / `clothing`（当日着装）。删除了 notable_day（低频 = digest 税，节日信息由 plots/foreshadowing 承担）；
2. **plots.time_hint 参照 story_state.current_time**，禁止「今天/当天/次日」等相对词；
3. **字段格式校验（迁移 0008，value_pattern + 回喂消息）**：`current_time`/`time_hint` 强制「第 N 天」开头（`^第\s*[0-9一二两三四五六七八九十]+\s*天[·、]?.+$`），`story_state.name` 固定「世界状态」；填错 → 提案被拒 → 错误回喂 → Agent 自愈重提（digest 同步渲染「格式：…」先见提示）。

### 10.2 核心结果（1–100 消息）

| 指标 | v3 | v4 | 结论 |
|---|---|---|---|
| 任务结果 | succeeded | succeeded | ✓ |
| 记录数 | 15 | 18（含 story_state） | plots 粒度回归 3 条 |
| story_state.name | 事件化（「回到宿舍的晚餐之夜」）✗ | **「世界状态」** ✓ | 固定值校验/prompt 生效 |
| current_time | 「黄昏（已回到宿舍…）」✗ | **「第二天清晨」** ✓ | **格式根治** |
| current_location | 无字段（地点塞进时间字段） | 「学校（自行车棚附近…）」✓ | 位置归位 |
| plots.time_hint | 「放学后傍晚至次日清晨到校」✗ | **3/3 全部「第二天清晨」** ✓ | **天数对齐状态表** |
| 当日服装 | 「健介的黑T恤」进 items ✗ | clothing 归位，items 无黑T恤 ✓ | 服装归位 |
| weather | 未填 | 「阴天，无日晒，海风阵阵…」✓ | ✓ |
| story_state 维护 | rev=1 | **rev=9（每块持续更新）** ✓ | Agent 可靠维护 |
| details 追加式 | 9 版累积 | 3 条 plot 各自累积（178/310/117 字）✓ | ✓ |
| 超限 | 0 | 0 | ✓ |

### 10.3 验证结论

- **时间坐标问题根治**：v3 的两类失败（跨天不填、新 plot 写「当天午后」）在 v4 全部消失——时间锚点从「prompt 文本软约束」变为「状态表数据事实」，Agent 每块查询时直接可见，plots.time_hint 全部与状态表对齐；
- **世界状态有归位处**：地点（此前塞进时间字段）、服装（此前进 items）、天气（此前无处可去）全部正确落位；
- **Agent 可靠维护状态表**：rev=9，且 story_state 是唯一记录（未新建第二条），覆盖式更新符合设计；
- **校验层作为兜底就位**：本次未观察到被拒重提事件流（任务事件不持久化），但格式全部正确的最终态 + 硬校验存在，保证未来不退化；
- plots 粒度回归 3 条（v3 是 1 条大 plot）：状态表承担时间推进后，Agent 不再把跨天事件硬并进一条 plot。

### 10.4 残余观察

- items.key_attributes 仍可能混入使用历史（v2 问题 8.3-2 未完全解决，本段 items 内容已更干净：套套 160 字 / 自行车 123 字）；
- todos.details 完成未清空问题本段未再出现（todos 1 条 rev=6，内容为采购动作）；
- 「学校·初遇阿长」plot rev=0（最后一块新建后未再更新，正常）；
- pattern 校验的「被拒→自愈」路径建议后续在测试层补一条 e2e（scripted agent 先提交错误格式 → 断言错误回喂 → 重提正确格式）。

---

## 11. 行动清单（按依赖顺序）

**立即修复（数据层，可在复制库上直接执行）**
1. `memory_fill_tasks`：残留 `running` 行 → `interrupted`（解除唯一索引阻塞）。
2. `memory_record_history`：清理 11 行孤儿历史（或加墓碑机制后保留）。
3. 决定 `extra_props_json` 中原始 `extra` 块的去留策略，必要时重导消息。

**短中期（代码层）**
4. 填表 agent 强制携带 evidence（1.2）→ 证据溯源真正生效，同时解决 `source_json` 全 null 问题。
5. 任务心跳 + 过期 running 清理（1.1），消除「复制库后无法启动任务」的坑。
6. 恢复任务继续处理 221–1231（2.1），并评估 block_size/取消语义。
7. failed 任务幂等约束（2.2）。
8. 系统表模板版本化 + 升级用例（2.5）。

**长期（Schema 演进，随新迁移落地）**
9. display_strategy CHECK/FK（3.1）、复合 FK 下沉（3.3）、evidence 时间戳（3.2）。
10. 引用物化表（3.5）、历史 diff 存储（3.4）——按规模再触发。

**上下文/接入优化（第 4 章，与 ST 接入同批落地）**
11. 长文本字段 `context_limit` 截断视图 + 引用字段返回 display 名（4.4，最大动态成本优化）。
12. 空提案块信号预筛跳过 + 块大小 5→15（4.5，最大时间优化，约 6–10 倍端到端提速）。
13. 模板审计：删除/禁用从未填写字段（special、start/end_time、due_date、test 表）并固化模板漂移修复（4.3）。
14. 表级分阶段启用（按消息量/记录数阈值，4.3）。
15. 清洗规则补充：复述行去重、空消息过滤（4.5）。

**字段有界化（第 5 章，用户重点）**
16. `memory_fields.max_chars` 迁移 + 模板为全部 long_text 定上限（5.3-1）。
17. 校验层长度硬校验 + 错误回喂（5.3-2，先做这个，其他都依赖它）。
18. digest 渲染上限提示（5.3-3）与 prompt 分层重写（5.3-4）随模板演进落地。
19. 现有 2 条超长记录（1634/929）触发一次压缩修复（重跑角色表或手动压缩）。

**v2 模板重构（第 6–7 章，与字段有界化同批）**
20. 按第 7 章 v2 设计重写系统表模板：删 notes/special、time 改相对时间、plots.details 改覆盖式、items.status 改枚举（7 节各表）。
21. 事件归位规则写进表级 prompt：事件只进 plots，其他表只写稳定状态，跨表用引用链（6.2-2，消除 5 处重复）。
22. 删除/禁用 test 表与从未填字段（6.1）；对现有 38 条记录做一次「事件去重 + 字段归位」重写（或随下次填表任务自然收敛）。

---

## 附录 A：分析脚本与数据快照命令

分析全部在 worktree `feature/db-analysis` 内对只读副本执行（`apps/api/node_modules/better-sqlite3`）：

```bash
# 完整性与一致性
PRAGMA integrity_check; PRAGMA foreign_key_check;
# 孤儿历史
SELECT record_id, COUNT(*) FROM memory_record_history
WHERE record_id NOT IN (SELECT id FROM memory_records) GROUP BY record_id;
# 残留任务
SELECT * FROM memory_fill_tasks WHERE status = 'running';
# 证据零引用
SELECT COUNT(*) FROM memory_records WHERE field_evidence_json != '{}';
# 空 prompt 字段
SELECT t.key, COUNT(*) FROM memory_fields f JOIN memory_tables t ON t.id=f.table_id
WHERE f.prompt = '' GROUP BY t.key;
```

## 附录 B：对照基线（seed 空间，不优化，仅记录）

- 藤ノ森学園の放課後 / 藤ノ森学园放学后：各 214 条记录（114 plots），两空间内容互为翻译；**无** `source_store_chats`（seed 未导入对话）。
- 冒烟测试：7 张系统表全空；`source_store_chats.metadata_json = {}`。
- 全库 466 条记录中 428 条（92%）来自 seed，真实数据仅平野健介1 的 38 条。
